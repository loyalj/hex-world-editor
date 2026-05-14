import * as THREE from 'three';
import {
  HexMap, ChunkManager, createLayout, POINTY_TOP,
  createWaterMaterial, createWaterShoreMaterial,
  createEstuaryMaterial, createRiverMaterial, createRoadMaterial,
  buildTerrainTextureArray, createTerrainMaterial,
  RtsCameraController,
  HexHashGrid,
  pickHexFromMeshes,
  hexToWorld, hexCorners, offsetToHex,
} from 'hex-world';
import type { ScatterLayerConfig } from 'hex-world';

const MAP_WIDTH   = 100;
const MAP_HEIGHT  = 100;
const CHUNK_SIZE  = 32;
const LOAD_RADIUS = 5;

export interface SceneApi {
  map: HexMap;
  chunks: ChunkManager;
  hoveredCell: { col: number; row: number } | null;
  reload(): void;
  replaceMap(newMap: HexMap): void;
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
  const terrainTex = await buildTerrainTextureArray();
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
  const pineLayer: ScatterLayerConfig = [
    [{ geometry: new THREE.ConeGeometry(0.42, 2.0, 7), material: treeMat, yOffset: 1.0 }],
    [{ geometry: new THREE.ConeGeometry(0.33, 1.5, 7), material: treeMat, yOffset: 0.75 }],
    [{ geometry: new THREE.ConeGeometry(0.24, 1.0, 7), material: treeMat, yOffset: 0.5 }],
  ];

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
      chunkSize:            CHUNK_SIZE,
      loadRadius:           LOAD_RADIUS,
      geometryOptions:      { colorMode: 'splat' },
      waterGeometryOptions: { waterLevel: -0.25 },
      hashGrid,
      scatterLayers: [pineLayer],
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

  // Hover indicator — flat translucent hex outline that follows the cursor
  const indicatorGeo = new THREE.BufferGeometry();
  const corners = hexCorners(layout, { q: 0, r: 0 });
  const verts: number[] = [];
  corners.forEach((c, i) => {
    const next = corners[(i + 1) % 6];
    verts.push(0, 0, 0, c.x, 0, c.z, next.x, 0, next.z);
  });
  indicatorGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
  const hoverMesh = new THREE.Mesh(
    indicatorGeo,
    new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.4,
      depthWrite: false, depthTest: false, side: THREE.DoubleSide,
    }),
  );
  hoverMesh.renderOrder = 5;
  hoverMesh.visible = false;
  scene.add(hoverMesh);

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
    reload() { api.chunks.dispose(); },
    replaceMap(newMap: HexMap): void {
      api.chunks.dispose();
      api.map    = newMap;
      api.chunks = makeChunks(newMap);
      controls.snapTo(newMap.width / 2, newMap.height / 2);
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

    const picked = pickHexFromMeshes(
      mouseX, mouseY, renderer.domElement, camera, layout, api.map,
      api.chunks.terrainMeshes,
    );
    api.hoveredCell = picked;

    if (picked) {
      const wp = hexToWorld(layout, offsetToHex(picked.col, picked.row));
      const elev = api.map.getElevation(picked.col, picked.row);
      hoverMesh.position.set(wp.x, elev * 0.5 + 0.02, wp.z);
      hoverMesh.visible = true;
    } else {
      hoverMesh.visible = false;
    }

    renderer.render(scene, camera);
  }
  animate();

  return api;
}
