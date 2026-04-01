const { cases } = require('../lib/cases-data');

module.exports = function handler(req, res) {
  res.json({ ok: true, caseCount: cases.length, first: cases[0] && cases[0].company });
};
