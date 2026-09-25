/** Convert a Python value crossing the Pyodide boundary into native JavaScript. */
export function pyProxyToJs(value: unknown): unknown {
  if (value && typeof (value as { toJs?: unknown }).toJs === "function") {
    return (value as { toJs: (options: unknown) => unknown }).toJs({
      dict_converter: Object.fromEntries,
    });
  }
  return value;
}
