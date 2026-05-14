import type { ConfigFieldDescriptor } from 'hex-world';

export type ConfigObj = Record<string, unknown>;

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
  schema: ConfigFieldDescriptor[],
  config: ConfigObj,
  onChange: () => void,
): void {
  container.innerHTML = '';

  const groups = new Map<string, ConfigFieldDescriptor[]>();
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

      if (field.type === 'select') {
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
