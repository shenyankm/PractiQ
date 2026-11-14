import sharp from "sharp";
import jsQR from "jsqr";
import { playbackAddress } from "../../shared/listening.js";
import { AppError, invariant } from "./errors.js";
import type { ListeningLink } from "./listening-web.js";

export async function qrListeningLinks(bytes: Uint8Array): Promise<ListeningLink[]> {
  invariant(bytes.length > 0 && bytes.length <= 25 * 1024 * 1024, "LOCAL_AUDIO_QR_INVALID", "Invalid QR image size");
  const prefix = Buffer.from(bytes.subarray(0, 8));
  invariant(prefix.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || prefix[0] === 255 && prefix[1] === 216 && prefix[2] === 255, "LOCAL_AUDIO_QR_INVALID", "Use a PNG or JPEG QR image");
  const image = sharp(bytes, { limitInputPixels: 4096 * 4096, failOn: "warning" }).timeout({ seconds: 5 });
  try {
    const meta = await image.metadata();
    invariant(["png", "jpeg"].includes(meta.format ?? "") && meta.width && meta.height && meta.width <= 4096 && meta.height <= 4096 && (meta.pages ?? 1) === 1, "LOCAL_AUDIO_QR_INVALID", "Use a PNG or JPEG QR image up to 4096 pixels per side");
    const { data, info } = await image.rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    invariant(info.channels === 4 && data.length <= 64 * 1024 * 1024, "LOCAL_AUDIO_QR_INVALID", "Invalid decoded QR image");
    const pixels = new Uint8ClampedArray(data), links: ListeningLink[] = [];
    const regions = [{ left: 0, top: 0, width: info.width, height: info.height, depth: 0 }];
    for (let count = 0; count < 50 && regions.length; count++) {
      const region = regions.pop()!, sample = new Uint8ClampedArray(region.width * region.height * 4);
      for (let y = 0; y < region.height; y++) sample.set(pixels.subarray(((region.top + y) * info.width + region.left) * 4, ((region.top + y) * info.width + region.left + region.width) * 4), y * region.width * 4);
      const code = jsQR(sample, region.width, region.height);
      if (!code) {
        // Overlapping regions avoid confusing finder patterns from neighboring QR codes.
        if (region.depth < 4 && Math.max(region.width, region.height) >= 80) {
          if (region.width >= region.height) {
            const width = Math.ceil(region.width * 2 / 3);
            regions.push({ ...region, width, depth: region.depth + 1 }, { ...region, left: region.left + region.width - width, width, depth: region.depth + 1 });
          } else {
            const height = Math.ceil(region.height * 2 / 3);
            regions.push({ ...region, height, depth: region.depth + 1 }, { ...region, top: region.top + region.height - height, height, depth: region.depth + 1 });
          }
        }
        continue;
      }
      const url = playbackAddress(code.data); if (url && !links.some(link => link.url === url)) links.push({ url, label: "" });
      const corners = [code.location.topLeftCorner, code.location.topRightCorner, code.location.bottomLeftCorner, code.location.bottomRightCorner];
      const left = Math.max(0, region.left + Math.floor(Math.min(...corners.map(point => point.x))) - 2), right = Math.min(info.width, region.left + Math.ceil(Math.max(...corners.map(point => point.x))) + 2);
      const top = Math.max(0, region.top + Math.floor(Math.min(...corners.map(point => point.y))) - 2), bottom = Math.min(info.height, region.top + Math.ceil(Math.max(...corners.map(point => point.y))) + 2);
      for (let y = top; y < bottom; y++) pixels.fill(255, (y * info.width + left) * 4, (y * info.width + right) * 4);
      regions.push(region);
    }
    invariant(links.length, "LOCAL_AUDIO_QR_INVALID", "No public playback address was found in the QR image"); return links;
  } catch (error) { if (error instanceof AppError) throw error; throw new AppError("LOCAL_AUDIO_QR_INVALID", "QR image decoding failed"); }
  finally { image.destroy(); }
}
