/**
 * Download inbound WhatsApp Cloud API media (camera photos).
 * GET /{media-id} returns a short-lived URL; a second GET with the token
 * returns the bytes. Never log the token or the file body.
 */
const GRAPH_VERSION = process.env.GRAPH_VERSION || 'v21.0';
const MAX_BYTES = 4 * 1024 * 1024;

function inboundWhatsAppImage(msg) {
  if (!msg) return null;
  if (msg.type === 'image' && msg.image) {
    return {
      id: msg.image.id,
      mime: msg.image.mime_type || 'image/jpeg',
      caption: msg.image.caption || ''
    };
  }
  if (msg.type === 'document' && msg.document && /^image\//i.test(msg.document.mime_type || '')) {
    return {
      id: msg.document.id,
      mime: msg.document.mime_type,
      caption: msg.document.caption || ''
    };
  }
  return null;
}

async function downloadWhatsAppMedia(mediaId, token = process.env.WHATSAPP_TOKEN) {
  if (!mediaId || !token || process.env.DRY_RUN === 'true') return null;
  const metaRes = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(mediaId)}`, {
    headers: { Authorization: 'Bearer ' + token }
  });
  const meta = await metaRes.json().catch(() => ({}));
  if (!metaRes.ok || !meta.url) {
    console.error('whatsapp media meta failed', meta && meta.error);
    return null;
  }
  const binRes = await fetch(meta.url, { headers: { Authorization: 'Bearer ' + token } });
  if (!binRes.ok) {
    console.error('whatsapp media download failed', binRes.status);
    return null;
  }
  const buf = Buffer.from(await binRes.arrayBuffer());
  if (!buf.length || buf.length > MAX_BYTES) return null;
  const mime = meta.mime_type || binRes.headers.get('content-type') || 'image/jpeg';
  if (!/^image\//i.test(mime)) return null;
  return { bytes: buf, mime, size: buf.length };
}

module.exports = { downloadWhatsAppMedia, inboundWhatsAppImage, MAX_BYTES };
