export type MediaType = 'image' | 'video';

export interface ValidatedMediaMime {
  mime: string;
  ext: string;
  mediaType: MediaType;
}

export function detectValidatedMediaMime(buffer: Buffer): ValidatedMediaMime | null {
  if (!buffer || buffer.length < 12) return null;

  // --- 1. Images ---

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mime: 'image/jpeg', ext: 'jpg', mediaType: 'image' };
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return { mime: 'image/png', ext: 'png', mediaType: 'image' };
  }

  // WebP: 'RIFF' .... 'WEBP'
  const isRiff = buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46;
  const isWebp = buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50;
  if (isRiff && isWebp) {
    return { mime: 'image/webp', ext: 'webp', mediaType: 'image' };
  }

  // --- 2. Videos ---

  // MP4 / M4V / QuickTime (ISO Base Media File Format: starts with [length: 4B] followed by 'ftyp')
  // buffer[4..7] is 'ftyp' (0x66, 0x74, 0x79, 0x70)
  if (
    buffer[4] === 0x66 &&
    buffer[5] === 0x74 &&
    buffer[6] === 0x79 &&
    buffer[7] === 0x70
  ) {
    const majorBrand = buffer.toString('ascii', 8, 12);
    if (majorBrand === 'qt  ' || majorBrand === 'moov') {
      return { mime: 'video/quicktime', ext: 'mov', mediaType: 'video' };
    }
    return { mime: 'video/mp4', ext: 'mp4', mediaType: 'video' };
  }

  // WebM / Matroska (EBML header: 1A 45 DF A3)
  if (
    buffer[0] === 0x1a &&
    buffer[1] === 0x45 &&
    buffer[2] === 0xdf &&
    buffer[3] === 0xa3
  ) {
    return { mime: 'video/webm', ext: 'webm', mediaType: 'video' };
  }

  // QuickTime MOV classic atoms (moov, mdat, free, wide)
  const atom = buffer.toString('ascii', 4, 8);
  if (atom === 'moov' || atom === 'mdat' || atom === 'wide' || atom === 'free') {
    return { mime: 'video/quicktime', ext: 'mov', mediaType: 'video' };
  }

  return null;
}

export function detectValidatedImageMime(buffer: Buffer): { mime: string; ext: string } | null {
  const result = detectValidatedMediaMime(buffer);
  if (result && result.mediaType === 'image') {
    return { mime: result.mime, ext: result.ext };
  }
  return null;
}
