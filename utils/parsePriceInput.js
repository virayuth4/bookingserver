const group = (s) => s.replace(/\B(?=(.{3})+$)/g, ",");

function parsePriceInput(raw) {
  const s = String(raw ?? "").toUpperCase().replace(/[\s,]/g, "");
  if (!s) return { kind: "empty" };

  if (/^0+$/.test(s)) {
    return { kind: "contact", value: 0, text: "0", min: null, max: null };
  }
  if (/^[1-9][0-9]*$/.test(s)) {
    const value = Number(s);
    return { kind: "exact", value, text: group(s), min: value, max: value };
  }
  if (/^[1-9][0-9]*X+$/.test(s)) {
    return {
      kind: "masked",
      text: group(s),
      min: Number(s.replace(/X/g, "0")),
      max: Number(s.replace(/X/g, "9")),
    };
  }
  return { kind: "invalid" };
}

module.exports = { parsePriceInput };