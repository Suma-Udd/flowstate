'use strict';

/*
 * The public half of the key that signs every release's latest.json. It is not
 * a secret. The private half lives only in the repository's GitHub Actions
 * secret FLOWSTATE_UPDATE_KEY and in the maintainer's own backup.
 */
const UPDATE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAXRO3U61h3ldkngIpBUbchseuZhuwcdq30WM0Cm0iKhQ=
-----END PUBLIC KEY-----
`;

const UPDATE_MANIFEST_URL =
  'https://github.com/Suma-Udd/flowstate/releases/latest/download/latest.json';

module.exports = { UPDATE_PUBLIC_KEY_PEM, UPDATE_MANIFEST_URL };
