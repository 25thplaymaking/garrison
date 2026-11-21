/** API paths used outside the server pages (which build their own). */
export const auth = {
  login: '/auth/login',
  logout: '/auth/logout',
  me: '/auth/me',
  password: '/auth/password',
};

export const users = {
  list: '/users',
  one: (id) => `/users/${id}`,
};

export const auditLogs = '/audit-logs';
