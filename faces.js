// Faces (0.15.x, owner): people's pictures wherever a person appears in the admin tools (Mod actions, Records).
// The Discord profile photo is the main picture; when we know their Roblox account (in-game records today), the
// Roblox headshot sits small on its lower right, or is the main picture when there's no Discord photo.
// Initials when there's nothing. Data: member_faces(ids) and the roblox_avatars cache (migration 0021), filled by
// the roblox-headshots Edge Function. Pictures are fetched once per page and painted into placeholders.
//
//   face({ name, discordId, robloxId, size })  -> HTML placeholder (sizes: 'xs' 20px, 's' 32px, 'm' 38px, 'l' 56px, 'xl' 88px)
//   await loadFaces(root)                      -> fetch what's missing for every placeholder in root, then paint
const FACE_D = new Map();   // discord_id -> avatar_url | null
const FACE_R = new Map();   // roblox_id  -> headshot url | null
const faceInitial = (s) => (cleanName(s || '?').trim()[0] || '?').toUpperCase();

function face({ name = '', discordId = '', robloxId = '', size = 'm', avatarUrl = '' } = {}) {
  if (avatarUrl && discordId && !FACE_D.has(discordId)) FACE_D.set(discordId, avatarUrl);
  return `<span class="face face-${size}" data-fd="${esc(discordId || '')}" data-fr="${esc(robloxId || '')}" aria-hidden="true">`
    + `<span class="face-i">${esc(faceInitial(name))}</span></span>`;
}

function paintFaces(root) {
  root.querySelectorAll('.face').forEach((el) => {
    const d = el.dataset.fd && FACE_D.get(el.dataset.fd), r = el.dataset.fr && FACE_R.get(el.dataset.fr);
    const main = d || r, badge = d && r ? r : null;
    if (main && !el.querySelector('.face-img')) el.insertAdjacentHTML('afterbegin', `<img class="face-img" src="${esc(d ? sized(d, 128) : r)}" alt="" loading="lazy" onerror="this.remove()">`);
    if (badge && !el.querySelector('.face-rb')) el.insertAdjacentHTML('beforeend', `<img class="face-rb" src="${esc(badge)}" alt="" loading="lazy" title="Roblox" onerror="this.remove()">`);
    el.classList.toggle('has-img', !!main);
  });
}

async function loadFaces(root) {
  if (!root) return;
  paintFaces(root);
  if (!access.admin) return;
  const els = [...root.querySelectorAll('.face')];
  const dIds = [...new Set(els.map((e) => e.dataset.fd).filter((x) => x && /^\d{15,22}$/.test(x) && !FACE_D.has(x)))];
  const rIds = [...new Set(els.map((e) => e.dataset.fr).filter((x) => x && /^\d{1,20}$/.test(x) && !FACE_R.has(x)))];
  await Promise.all([
    dIds.length && sb.rpc('member_faces', { ids: dIds }).then(({ data }) => {
      dIds.forEach((id) => FACE_D.set(id, null));
      (data || []).forEach((m) => FACE_D.set(m.discord_id, m.avatar_url || null));
    }, () => {}),
    rIds.length && (async () => {
      const { data } = await sb.from('roblox_avatars').select('roblox_id, url, fetched_at').in('roblox_id', rIds);
      const fresh = new Set();
      (data || []).forEach((a) => { FACE_R.set(a.roblox_id, a.url || null); if (Date.now() - new Date(a.fetched_at) < 7 * 864e5) fresh.add(a.roblox_id); });
      const need = rIds.filter((id) => !fresh.has(id));
      need.forEach((id) => { if (!FACE_R.has(id)) FACE_R.set(id, null); });
      if (need.length) {
        const { data: res } = await sb.functions.invoke('roblox-headshots', { body: { ids: need } }).catch(() => ({ data: null }));
        Object.entries((res && res.avatars) || {}).forEach(([id, url]) => FACE_R.set(id, url || null));
      }
    })().catch(() => {}),
  ]);
  if (root.isConnected) paintFaces(root);
}
