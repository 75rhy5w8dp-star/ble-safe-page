const XOR_KEY = [0xf6, 0x1e, 0x25, 0x62];

export const COCO = Object.freeze({
  service: "0000ff60-0000-1000-8000-00805f9b34fb",
  characteristic: "0000ff61-0000-1000-8000-00805f9b34fb",
  suction: 0x01,
  vibration: 0x02,
  maxLevel: 20
});

export function cocoPacket(opcode, motorMask, value = 0) {
  const plain = [0x35, opcode, motorMask, value];
  plain.push(plain.reduce((sum, byte) => (sum + byte) & 0xff, 0));
  return new Uint8Array(plain.map((byte, index) => byte ^ XOR_KEY[index % XOR_KEY.length]));
}

export function cocoSet(motorMask, level) {
  const safeLevel = Math.max(0, Math.min(COCO.maxLevel, Math.round(Number(level) || 0)));
  return safeLevel === 0
    ? cocoPacket(0x60, motorMask, 0)
    : cocoPacket(0x62, motorMask, safeLevel);
}

export function cocoStopAll() {
  return cocoPacket(0x60, 0x00, 0);
}

export function bytesToHex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0").toUpperCase()).join("");
}
