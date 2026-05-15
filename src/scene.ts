import * as THREE from 'three';
import {
  HexMap, ChunkManager, createLayout, POINTY_TOP,
  createWaterMaterial, createWaterShoreMaterial,
  createEstuaryMaterial, createRiverMaterial, createRoadMaterial,
  buildTerrainTextureArray, createTerrainMaterial,
  DEFAULT_TERRAIN_DESCRIPTORS, DEFAULT_TERRAIN_DEFINITIONS,
  RtsCameraController,
  HexHashGrid,
  pickHexFromMeshes, pickHex,
  hexToWorld, hexCorners, offsetToHex, hexToOffset, smoothPath, hexRange,
} from '@loyalj/hex-world';
import type { ScatterDefinition, HexCoord } from '@loyalj/hex-world';

const MAP_WIDTH      = 100;
const MAP_HEIGHT     = 100;
const CHUNK_SIZE     = 32;
const LOAD_RADIUS    = 5;
const WATER_SURFACE_Y = -0.25; // must match waterGeometryOptions.waterLevel

export interface SceneApi {
  map: HexMap;
  chunks: ChunkManager;
  hoveredCell: { col: number; row: number } | null;
  brushRadius: number;
  reload(): void;
  replaceMap(newMap: HexMap): void;
  setPathPreview(path: HexCoord[] | null, erasing?: boolean): void;
}

export async function initScene(container: HTMLElement): Promise<SceneApi> {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1a2e);

  const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 500);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(devicePixelRatio);
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.9;
  container.appendChild(renderer.domElement);

  // Lighting
  const ambient = new THREE.AmbientLight(0xd0e0ff, 0.5);
  const sun = new THREE.DirectionalLight(0xfff4d0, 1.4);
  sun.position.set(100, 120, 80);
  scene.add(ambient, sun);

  // Materials
  const terrainTex = await buildTerrainTextureArray(DEFAULT_TERRAIN_DESCRIPTORS);
  const terrainMaterial = createTerrainMaterial(terrainTex, {
    lightDir:   new THREE.Vector3(100, 120, 80),
    lightColor: new THREE.Color(0xfff4d0).multiplyScalar(0.7),
    ambient:    new THREE.Color(0xd0e0ff).multiplyScalar(0.45),
  });
  const waterMaterial   = createWaterMaterial();
  const shoreMaterial   = createWaterShoreMaterial();
  const estuaryMaterial = createEstuaryMaterial();
  const riverMaterial   = createRiverMaterial();
  const roadMaterial    = createRoadMaterial();

  const layout   = createLayout(POINTY_TOP, 1);
  const hashGrid = new HexHashGrid(1234);

  // Scatter — pine trees on 3 density tiers
  const treeMat = new THREE.MeshLambertMaterial({ color: 0x5e8c2a });
  const pineDefinition: ScatterDefinition = {
    id:         'pine',
    name:       'Pine Trees',
    layerIndex: 0,
    tiers: [
      [{ geometry: new THREE.ConeGeometry(0.42, 2.0, 7), material: treeMat, yOffset: 1.0 }],
      [{ geometry: new THREE.ConeGeometry(0.33, 1.5, 7), material: treeMat, yOffset: 0.75 }],
      [{ geometry: new THREE.ConeGeometry(0.24, 1.0, 7), material: treeMat, yOffset: 0.5 }],
    ],
  };

  const map = new HexMap({ width: MAP_WIDTH, height: MAP_HEIGHT, featureLayerCount: 1 });

  function makeChunks(targetMap: HexMap): ChunkManager {
    return new ChunkManager({
      map:                  targetMap,
      layout,
      scene,
      material:             terrainMaterial,
      waterMaterial,
      shoreMaterial,
      estuaryMaterial,
      riverMaterial,
      roadMaterial,
      terrainDefinitions:   DEFAULT_TERRAIN_DEFINITIONS,
      chunkSize:            CHUNK_SIZE,
      loadRadius:           LOAD_RADIUS,
      geometryOptions:      { colorMode: 'splat' },
      waterGeometryOptions: { waterLevel: -0.25 },
      hashGrid,
      scatterDefinitions: [pineDefinition],
    });
  }

  const controls = new RtsCameraController({
    camera,
    domElement:      renderer.domElement,
    initialTarget:   { x: MAP_WIDTH / 2, z: MAP_HEIGHT / 2 },
    initialDistance: 60,
    minPitch:        30,
    maxPitch:        66,
    minDistance:     6,
    maxDistance:     80,
  });

  new ResizeObserver(() => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  }).observe(container);

  // Hover indicator — rebuilt each frame to cover the brush footprint
  const hoverGeo = new THREE.BufferGeometry();
  hoverGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
  const hoverMesh = new THREE.Mesh(
    hoverGeo,
    new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.4,
      depthWrite: false, depthTest: false, side: THREE.DoubleSide,
    }),
  );
  hoverMesh.renderOrder = 5;
  hoverMesh.visible = false;
  scene.add(hoverMesh);

  // Road/river start indicator — static single-hex shape, repositioned each frame
  const startCorners = hexCorners(layout, { q: 0, r: 0 });
  const startVerts: number[] = [];
  startCorners.forEach((c, i) => {
    const next = startCorners[(i + 1) % 6];
    startVerts.push(0, 0, 0, c.x, 0, c.z, next.x, 0, next.z);
  });
  const startGeo = new THREE.BufferGeometry();
  startGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(startVerts), 3));
  const startMat = new THREE.MeshBasicMaterial({
    color: 0xffaa22, transparent: true, opacity: 0.55,
    depthWrite: false, depthTest: false, side: THREE.DoubleSide,
  });
  const startMesh = new THREE.Mesh(startGeo, startMat);
  startMesh.renderOrder = 5;
  startMesh.visible = false;
  scene.add(startMesh);

  // Road path preview line
  const previewLineGeo = new THREE.BufferGeometry();
  previewLineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
  const previewLineMat = new THREE.LineBasicMaterial({ color: 0xffaa22, depthTest: false, depthWrite: false });
  const previewLine = new THREE.Line(previewLineGeo, previewLineMat);
  previewLine.renderOrder = 6;
  previewLine.visible = false;
  scene.add(previewLine);

  // Mouse tracking for picking
  let mouseX = 0;
  let mouseY = 0;
  renderer.domElement.addEventListener('pointermove', e => {
    mouseX = e.clientX;
    mouseY = e.clientY;
  });

  const api: SceneApi = {
    map,
    chunks: makeChunks(map),
    hoveredCell: null,
    brushRadius: 0,
    reload() { api.chunks.dispose(); },
    replaceMap(newMap: HexMap): void {
      api.chunks.dispose();
      api.map    = newMap;
      api.chunks = makeChunks(newMap);
      controls.snapTo(newMap.width / 2, newMap.height / 2);
    },
    setPathPreview(path: HexCoord[] | null, erasing = false): void {
      if (!path || path.length === 0) {
        startMesh.visible   = false;
        previewLine.visible = false;
        return;
      }

      const color = erasing ? 0xff4444 : 0xffaa22;
      startMat.color.setHex(color);
      previewLineMat.color.setHex(color);

      const startOff = hexToOffset(path[0]);
      const startWp  = hexToWorld(layout, path[0]);
      startMesh.position.set(startWp.x, api.map.getElevation(startOff.col, startOff.row) * 0.5 + 0.03, startWp.z);
      startMesh.visible = true;

      if (path.length < 2) {
        previewLine.visible = false;
        return;
      }

      const pts = smoothPath(path, layout, api.map);
      const positions = new Float32Array(pts.length * 3);
      pts.forEach((p, i) => {
        positions[i * 3]     = p.x;
        positions[i * 3 + 1] = p.y + 0.15;
        positions[i * 3 + 2] = p.z;
      });
      previewLine.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      previewLine.visible = true;
    },
  };

  function animate() {
    requestAnimationFrame(animate);
    controls.update();
    api.chunks.update(camera);

    const t = performance.now() / 1000;
    waterMaterial.uniforms['uTime'].value   = t;
    shoreMaterial.uniforms['uTime'].value   = t;
    estuaryMaterial.uniforms['uTime'].value = t;
    riverMaterial.uniforms['uTime'].value   = t;

    let picked = pickHexFromMeshes(
      mouseX, mouseY, renderer.domElement, camera, layout, api.map,
      api.chunks.terrainMeshes,
    );
    // Terrain geometry for underwater cells sits at seabed depth; at a camera
    // angle the ray hits a shifted position that maps to the wrong surface cell.
    // Re-pick against the water surface plane to get what the user sees.
    if (picked && api.map.getElevation(picked.col, picked.row) < 0) {
      picked = pickHex(mouseX, mouseY, renderer.domElement, camera, layout, api.map, WATER_SURFACE_Y);
    }
    api.hoveredCell = picked;

    if (picked) {
      const cells = hexRange(offsetToHex(picked.col, picked.row), api.brushRadius)
        .filter(h => {
          const o = hexToOffset(h);
          return o.col >= 0 && o.col < api.map.width && o.row >= 0 && o.row < api.map.height;
        });
      const verts: number[] = [];
      for (const hex of cells) {
        const off = hexToOffset(hex);
        const elev = api.map.getElevation(off.col, off.row);
        const y = (elev < 0 ? WATER_SURFACE_Y : elev * 0.5) + 0.02;
        const center = hexToWorld(layout, hex);
        const cs = hexCorners(layout, hex);
        for (let i = 0; i < 6; i++) {
          const c1 = cs[i], c2 = cs[(i + 1) % 6];
          verts.push(center.x, y, center.z, c1.x, y, c1.z, c2.x, y, c2.z);
        }
      }
      hoverGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
      hoverMesh.visible = true;
    } else {
      hoverMesh.visible = false;
    }

    renderer.render(scene, camera);
  }
  animate();

  return api;
}
