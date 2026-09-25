"""Keep benchmark timings and repetition counts deterministic."""
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path


def test_measure_runs_three_timed_samples(monkeypatch):
    spec = spec_from_file_location(
        "benchmark_processing", Path(__file__).parents[1] / "scripts/benchmark_processing.py"
    )
    assert spec is not None and spec.loader is not None
    benchmark = module_from_spec(spec)
    spec.loader.exec_module(benchmark)
    clock = iter([0.0, 0.003, 1.0, 1.001, 2.0, 2.002])
    monkeypatch.setattr(benchmark, "perf_counter", lambda: next(clock))
    calls = []

    def run():
        calls.append(len(calls) + 1)
        return calls[-1]

    result, elapsed = benchmark.measure(run)
    assert calls == [1, 2, 3]
    assert result == 3
    assert round(elapsed, 6) == 2.0
