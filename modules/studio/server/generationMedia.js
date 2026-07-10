// Maps studio generation modes to a coarse media type and helps infer file
// extensions / mime types for stored outputs.

const MODE_MEDIA_TYPES = {
  t2i: 'image',
  i2i: 'image',
  cinema: 'image',
  t2v: 'video',
  i2v: 'video',
  v2v: 'video',
  marketing: 'video',
  lipsync: 'video',
  recast: 'video',
  audio: 'audio',
  t2t: 'text',
};

export function mediaTypeForMode(mode) {
  return MODE_MEDIA_TYPES[mode] || 'image';
}

export function isKnownMode(mode) {
  return Object.prototype.hasOwnProperty.call(MODE_MEDIA_TYPES, mode);
}

const EXT_BY_MEDIA_TYPE = {
  image: 'png',
  video: 'mp4',
  audio: 'mp3',
  text: 'txt',
};

const CONTENT_TYPE_BY_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  txt: 'text/plain',
};

// Derive a file extension from a URL and/or content-type header, falling back
// to a media-type default.
export function inferExtension({ url, contentType, mediaType } = {}) {
  if (url) {
    try {
      const pathname = new URL(url).pathname;
      const match = pathname.match(/\.([a-zA-Z0-9]{1,5})$/);
      if (match) return match[1].toLowerCase();
    } catch {
      // ignore malformed URLs
    }
  }

  if (contentType) {
    const normalized = contentType.split(';')[0].trim().toLowerCase();
    for (const [ext, mime] of Object.entries(CONTENT_TYPE_BY_EXT)) {
      if (mime === normalized) return ext;
    }
  }

  return EXT_BY_MEDIA_TYPE[mediaType] || 'bin';
}

export function contentTypeForExt(ext) {
  return CONTENT_TYPE_BY_EXT[String(ext || '').toLowerCase()] || 'application/octet-stream';
}

