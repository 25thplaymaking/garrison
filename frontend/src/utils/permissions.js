/**
 * Roles and permissions, mirroring backend/middleware/rbac.py.
 *   admin     manages servers and panel accounts
 *   operator  manages servers
 */
export const ROLES = { ADMIN: 'admin', OPERATOR: 'operator' };

export const PERMISSIONS = {
  MANAGE_SERVERS: 'manage_servers',
  MANAGE_USERS: 'manage_users',
};

const ROLE_PERMISSIONS = {
  admin: new Set([PERMISSIONS.MANAGE_SERVERS, PERMISSIONS.MANAGE_USERS]),
  operator: new Set([PERMISSIONS.MANAGE_SERVERS]),
};

export function hasPermission(role, permission) {
  return ROLE_PERMISSIONS[role]?.has(permission) ?? false;
}

export function hasAnyPermission(role, ...permissions) {
  return permissions.some((p) => hasPermission(role, p));
}
