export type Child = Node | string | number | false | null | undefined;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  // 页面中会传 min/max 数字、style 字符串、on* 函数；这里统一在创建时归一化
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  props: Record<string, any> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue;
    if (key === 'class') el.className = String(value);
    else if (key === 'style' && typeof value === 'string') el.style.cssText = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else {
      try {
        (el as unknown as Record<string, unknown>)[key] = value;
      } catch {
        el.setAttribute(key, String(value));
      }
    }
  }
  for (const child of children) appendChild(el, child);
  return el;
}

export function appendChild(el: HTMLElement, child: Child) {
  if (child === false || child === null || child === undefined) return;
  el.append(child instanceof Node ? child : document.createTextNode(String(child)));
}

export function clear(el: HTMLElement) {
  el.replaceChildren();
}

export function fmt(x: number | null | undefined, digits = 2): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return '—';
  const fixed = x.toFixed(digits);
  const [int, dec] = fixed.split('.');
  const sign = int.startsWith('-') ? '-' : '';
  const absInt = sign ? int.slice(1) : int;
  const grouped = absInt.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${grouped}${dec ? `.${dec}` : ''}`;
}

export function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fmtClock(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function downloadJson(data: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function readJsonFile<T>(file: File): Promise<T> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try { resolve(JSON.parse(String(reader.result)) as T); } catch (e) { reject(e); }
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}
