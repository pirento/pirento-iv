/**
 * Reads the first sheet of an Excel .xlsx file in the browser into rows of cells (text or numbers),
 * using the browser's own DecompressionStream; the file never leaves the computer.
 * shortcut: first sheet only and no old .xls files; ask for CSV or .xlsx when a bank gives .xls.
 */

const text = new TextDecoder();

export async function readXlsxRows(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  let end = bytes.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0) throw new Error('This is not an Excel .xlsx file. Save the statement as CSV or .xlsx.');
  const files = new Map();
  for (
    let index = 0, offset = view.getUint32(end + 16, true);
    index < view.getUint16(end + 10, true);
    index++
  ) {
    const nameLength = view.getUint16(offset + 28, true);
    files.set(text.decode(bytes.subarray(offset + 46, offset + 46 + nameLength)), {
      method: view.getUint16(offset + 10, true),
      size: view.getUint32(offset + 20, true),
      local: view.getUint32(offset + 42, true),
    });
    offset += 46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
  const read = async (name) => {
    const file = files.get(name);
    if (!file) return '';
    const start =
      file.local + 30 + view.getUint16(file.local + 26, true) + view.getUint16(file.local + 28, true);
    const data = bytes.subarray(start, start + file.size);
    if (file.method === 0) return text.decode(data);
    return await new Response(
      new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')),
    ).text();
  };
  const xml = (source) => new DOMParser().parseFromString(source, 'application/xml');
  const strings = [...xml((await read('xl/sharedStrings.xml')) || '<sst/>').getElementsByTagName('si')].map(
    (item) => [...item.getElementsByTagName('t')].map((node) => node.textContent).join(''),
  );
  const sheetName =
    [...files.keys()].filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).sort()[0] ?? '';
  const rows = [];
  for (const cell of xml(await read(sheetName)).getElementsByTagName('c')) {
    const [, letters, row] = /^([A-Z]+)(\d+)$/.exec(cell.getAttribute('r') ?? '') ?? [];
    if (!letters) continue;
    const column = [...letters].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0) - 1;
    const type = cell.getAttribute('t');
    const raw = cell.getElementsByTagName('v')[0]?.textContent ?? '';
    const value =
      type === 's'
        ? (strings[Number(raw)] ?? '')
        : type === 'inlineStr'
          ? [...cell.getElementsByTagName('t')].map((node) => node.textContent).join('')
          : type === 'str' || type === 'b' || raw === ''
            ? raw
            : Number(raw);
    (rows[Number(row) - 1] ??= [])[column] = value;
  }
  return Array.from(rows, (row) =>
    Array.from(row ?? [], (cell) => (typeof cell === 'string' ? cell.trim() : (cell ?? ''))),
  );
}
