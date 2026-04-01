const { cases } = require('../lib/cases-data');

export default function handler(req: any, res: any) {
  res.json({ ok: true, caseCount: cases.length, first: cases[0]?.company });
}
