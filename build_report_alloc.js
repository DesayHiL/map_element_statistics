// 只更新 out/report_alloc.json，不生成已经停用的 report_draft.html。
process.env.ODD_ALLOC_ONLY = '1';
require('./build_report_draft.js');
