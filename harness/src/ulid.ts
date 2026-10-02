import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let lastTime = 0;
let lastRandom: number[] = [];

/** Monotonic ULID: sortable by creation time, so job ids order the queue. */
export function ulid(now = Date.now()): string {
  let random: number[];
  if (now === lastTime) {
    random = [...lastRandom];
    for (let i = random.length - 1; i >= 0; i--) {
      if (random[i]! < 31) {
        random[i]!++;
        break;
      }
      random[i] = 0;
    }
  } else {
    random = [...randomBytes(16)].map((byte) => byte & 31);
  }
  lastTime = now;
  lastRandom = random;

  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  return time + random.map((n) => ALPHABET[n]).join("");
}
