/** Names accepted inside a manual-recovery [角色-...] tag. */
export function manualReplyRoleNames(contact) {
  const names = new Set();
  const add = value => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (trimmed) names.add(trimmed);
  };
  if (!contact || typeof contact !== 'object') return [];
  add(contact.name);
  add(contact.remark);
  add(contact.id);
  // tavern_<character name>: the original SillyTavern name survives even when
  // the phone contact was renamed for display.
  if (typeof contact.id === 'string' && contact.id.startsWith('tavern_')) add(contact.id.slice('tavern_'.length));
  return [...names];
}

export function isManualReplyRoleName(contact, roleName) {
  if (typeof roleName !== 'string') return false;
  const candidate = roleName.trim().toLocaleLowerCase();
  if (!candidate) return false;
  return manualReplyRoleNames(contact).some(name => name.toLocaleLowerCase() === candidate);
}
