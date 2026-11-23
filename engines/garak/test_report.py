"""garak sidecar 报告聚合核心单测（纯 stdlib，无需 garak/torch）。

约定：report.aggregate_report(records) 把 garak report.jsonl 的 eval 记录聚合为
apps/api 侧 garak.ts 适配器消费的形状：
    {"probes": [{probe, detector, total, passed, failed, failure_rate}, ...]}
report.parse_report_lines(text) 把 JSONL 文本安全解析为 dict 列表（跳过坏行）。
"""
import unittest

from report import aggregate_report, parse_report_lines


class ParseReportLinesTest(unittest.TestCase):
    def test_parses_valid_jsonl_and_skips_blank_and_garbage(self):
        text = (
            '{"entry_type": "start", "garak_version": "0.9"}\n'
            "\n"
            "   \n"
            "this is not json\n"
            '{"entry_type": "eval", "probe": "dan.Dan_11_0", '
            '"detector": "mitigation.MitigationBypass", "passed": 6, "total": 10}\n'
        )
        recs = parse_report_lines(text)
        self.assertEqual(len(recs), 2)
        self.assertEqual(recs[0]["entry_type"], "start")
        self.assertEqual(recs[1]["probe"], "dan.Dan_11_0")


class AggregateReportTest(unittest.TestCase):
    def test_mixed_pass_and_fail_probes(self):
        records = [
            {"entry_type": "start", "garak_version": "0.9"},
            {
                "entry_type": "eval",
                "probe": "dan.Dan_11_0",
                "detector": "mitigation.MitigationBypass",
                "passed": 6,
                "total": 10,
            },
            {
                "entry_type": "eval",
                "probe": "promptinject.HijackHateHumans",
                "detector": "promptinject.AttackRogueString",
                "passed": 10,
                "total": 10,
            },
        ]
        out = aggregate_report(records)
        self.assertIn("probes", out)
        self.assertEqual(len(out["probes"]), 2)

        failing = out["probes"][0]
        self.assertEqual(failing["probe"], "dan.Dan_11_0")
        self.assertEqual(failing["detector"], "mitigation.MitigationBypass")
        self.assertEqual(failing["total"], 10)
        self.assertEqual(failing["passed"], 6)
        self.assertEqual(failing["failed"], 4)
        self.assertAlmostEqual(failing["failure_rate"], 0.4)

        clean = out["probes"][1]
        self.assertEqual(clean["failed"], 0)
        self.assertAlmostEqual(clean["failure_rate"], 0.0)

    def test_ignores_non_eval_entries(self):
        records = [
            {"entry_type": "config"},
            {"entry_type": "attempt", "probe": "x"},
            {"entry_type": "digest"},
        ]
        out = aggregate_report(records)
        self.assertEqual(out["probes"], [])

    def test_zero_total_does_not_divide_by_zero(self):
        records = [
            {
                "entry_type": "eval",
                "probe": "empty.Probe",
                "detector": "some.Detector",
                "passed": 0,
                "total": 0,
            }
        ]
        out = aggregate_report(records)
        self.assertEqual(len(out["probes"]), 1)
        self.assertEqual(out["probes"][0]["failed"], 0)
        self.assertAlmostEqual(out["probes"][0]["failure_rate"], 0.0)
