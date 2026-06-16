import type { ConfigFieldDescriptor } from '@loyalj/hex-world';

export type ConfigObj = Record<string, unknown>;

export type ImageFieldDescriptor = {
  key: string;
  label: string;
  type: 'image';
  default: null;
  group?: string;
};

/** Superset of the library's ConfigFieldDescriptor that adds an image-picker field. */
export type ConfigFieldEx = ConfigFieldDescriptor | ImageFieldDescriptor;

function getPath(obj: ConfigObj, path: string): unknown {
  const keys = path.split('.');
  let curr: unknown = obj;
  for (const k of keys) {
    if (curr == null || typeof curr !== 'object') return undefined;
    curr = (curr as ConfigObj)[k];
  }
  return curr;
}

function setPath(obj: ConfigObj, path: string, value: unknown): void {
  const keys = path.split('.');
  let curr = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (curr[k] == null || typeof curr[k] !== 'object') curr[k] = {};
    curr = curr[k] as ConfigObj;
  }
  curr[keys[keys.length - 1]] = value;
}

export function renderConfigFields(
  container: HTMLElement,
  schema: ConfigFieldEx[],
  config: ConfigObj,
  onChange: () => void,
): void {
  container.innerHTML = '';

  const groups = new Map<string, ConfigFieldEx[]>();
  for (const field of schema) {
    const group = field.group ?? '';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)!.push(field);
  }

  for (const [groupName, fields] of groups) {
    if (groupName) {
      const header = document.createElement('div');
      header.className = 'group-header';
      header.textContent = groupName;
      container.appendChild(header);
    }

    for (const field of fields) {
      const currentValue = getPath(config, field.key) ?? field.default;
      const label = document.createElement('label');
      label.className = 'field';

      const span = document.createElement('span');
      span.textContent = field.label;
      label.appendChild(span);

      if (field.type === 'image') {
        const wrapper = document.createElement('div');
        wrapper.className = 'image-picker';

        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = 'image/*';
        fileInput.style.display = 'none';

        const pickBtn = document.createElement('button');
        pickBtn.type = 'button';
        pickBtn.className = 'image-pick-btn';
        pickBtn.textContent = 'Choose image…';

        const status = document.createElement('span');
        status.className = 'image-pick-status';
        const existing = getPath(config, field.key);
        status.textContent = existing ? 'Image loaded' : 'No image';

        pickBtn.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', () => {
          const file = fileInput.files?.[0];
          if (!file) return;
          const url = URL.createObjectURL(file);
          const img = new Image();
          img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;
            canvas.getContext('2d')!.drawImage(img, 0, 0);
            const data = canvas.getContext('2d')!.getImageData(0, 0, img.width, img.height);
            URL.revokeObjectURL(url);
            setPath(config, field.key, { pixels: data.data, width: img.width, height: img.height });
            status.textContent = `${img.width} × ${img.height}`;
            onChange();
          };
          img.src = url;
        });

        wrapper.appendChild(fileInput);
        wrapper.appendChild(pickBtn);
        wrapper.appendChild(status);
        label.appendChild(wrapper);
      } else if (field.type === 'select') {
        const sel = document.createElement('select');
        for (const opt of field.options ?? []) {
          const option = document.createElement('option');
          option.value = String(opt.value);
          option.textContent = opt.label;
          if (String(opt.value) === String(currentValue)) option.selected = true;
          sel.appendChild(option);
        }
        sel.addEventListener('change', () => {
          setPath(config, field.key, sel.value);
          onChange();
        });
        label.appendChild(sel);
      } else if (field.type === 'boolean') {
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = Boolean(currentValue);
        cb.addEventListener('change', () => {
          setPath(config, field.key, cb.checked);
          onChange();
        });
        label.appendChild(cb);
      } else {
        const num = document.createElement('input');
        num.type = 'number';
        if (field.min !== undefined) num.min = String(field.min);
        if (field.max !== undefined) num.max = String(field.max);
        num.step = field.type === 'integer' ? '1' : (field.step !== undefined ? String(field.step) : 'any');
        num.value = String(currentValue);
        num.addEventListener('change', () => {
          const v = parseFloat(num.value);
          setPath(config, field.key, field.type === 'integer' ? Math.round(v) : v);
          onChange();
        });
        label.appendChild(num);
      }

      container.appendChild(label);
    }
  }
}
