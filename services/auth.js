const axios = require("axios");
require("dotenv").config();
const urlStrapi = process.env.URL_STRAPI;

// Аккуратно вытаскиваем читаемые имена роли и view_role
const takeRoleName = (role) => {
  if (!role) return null;
  if (typeof role === "string") return role;
  if (Array.isArray(role))
    return role.map(takeRoleName).filter(Boolean).join(", ");
  return role.name || role.type || role.code || role.id || null;
};
const takeViewRole = (vr) => {
  if (!vr) return null;
  if (typeof vr === "string") return vr;
  if (Array.isArray(vr)) return vr.map(takeViewRole).filter(Boolean).join(", ");
  return vr.name || vr.code || vr.slug || vr.id || null;
};

const auth = {
  fetchAuth: async (token) => {
    try {
      const url = `${urlStrapi}/api/users/me?populate[role]=*&populate[view_role]=*`;
      const res = await axios.get(url, {
        headers: { Authorization: token },
      });

      const user = res?.data;
      if (user) {
        const roleName = takeRoleName(user.role);
        const viewRoleName = takeViewRole(user.view_role ?? user.viewRole);

        // 🌟 Лаконичный лог на русском
        console.log(
          `[auth] Пользователь авторизован:\n` +
            `  id: ${user.id ?? "—"}\n` +
            `  username: ${user.username ?? "—"}\n` +
            `  email: ${user.email ?? "—"}\n` +
            `  роль (role): ${roleName ?? "—"}\n` +
            `  view_role: ${viewRoleName ?? "—"}`
        );

        return user;
      } else {
        console.log("[auth] Пустой ответ от /users/me");
        return false;
      }
    } catch (error) {
      const prefix = typeof token === "string" ? token.slice(0, 16) : "";
      if (error.response) {
        console.log(
          `[auth] Ошибка запроса /users/me (HTTP ${error.response.status}); токен: ${prefix}…`
        );
        console.log("[auth] Тело ошибки:", error.response.data);
      } else {
        console.log("[auth] Ошибка запроса /users/me:", error.message);
      }
      return false;
    }
  },
};

module.exports = auth;

// const axios = require('axios')
// require('dotenv').config()
// const urlStrapi = process.env.URL_STRAPI

// const auth = {
//     fetchAuth: async (token) => {
//         try {
//             const res = await axios.get(`${urlStrapi}/api/users/me`,{
//                 headers:{
//                     Authorization: token
//                 }
//             })
//             if (res.data) {
//                 return res.data
//             } else {
//                 console.log(res.data);
//                 return false
//             }
//         } catch (error) {
//             console.log("error", error);
//         }
//     }
// }
// module.exports = auth;
