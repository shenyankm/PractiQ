"""Synthetic CPU-only crop/merge benchmark; no files, credentials or model calls."""
import argparse
import json
from io import BytesIO
from pathlib import Path
from statistics import median
from time import perf_counter

from PIL import Image, ImageDraw

from practiq_ai.contracts import ParsedQuestion
from practiq_ai.graphs.chunking import merge_chunk_results
from practiq_ai.graphs.vision import crop_figure, crop_figures


def measure(run):
    start = perf_counter()
    result = run()
    timings = [(perf_counter() - start) * 1000]
    for _ in range(2):
        start = perf_counter()
        result = run()
        timings.append((perf_counter() - start) * 1000)
    return result, median(timings)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    with Image.new('RGB', (2480, 3508), 'white') as page:
        draw = ImageDraw.Draw(page)
        for y in range(0, 3508, 30):
            draw.text((50, y), 'Synthetic textbook question: 1+2=3; ABCDEFGHIJKLMNOPQRSTUVWXYZ ' * 4, fill='black')
            draw.line((20, y + 22, 2460, y + 22), fill=(y % 255, 70, 110), width=2)
        buffer = BytesIO()
        page.save(buffer, 'PNG')
    payload = buffer.getvalue()
    boxes = [[.02, .02 + .016 * i, .42, .06 + .016 * i] for i in range(50)]
    individual, old_ms = measure(lambda: [crop_figure(payload, box) for box in boxes])
    batch, batch_ms = measure(lambda: crop_figures(payload, boxes))
    assert batch == individual and all(batch)
    text = '\n'.join(f'Unique question {i:04d}.' for i in range(1000))
    questions = [ParsedQuestion(stem=line, sourceText=line, answerMode='short_answer') for line in text.splitlines()]
    merged, merge_ms = measure(lambda: merge_chunk_results(
        [(0, questions, []), (1, questions, [])], source_text=text,
        chunk_spans=[{'start': 0, 'end': len(text), 'overlapStart': 0, 'overlapEnd': 0},
                     {'start': 0, 'end': len(text), 'overlapStart': 0, 'overlapEnd': len(text)}],
    ))
    assert len(merged[0]) == 1000 and not merged[3]
    report = {'repetitions': 3, 'pagePixels': [2480, 3508], 'crops': 50,
              'perCropDecodeMedianMs': old_ms, 'batchDecodeMedianMs': batch_ms,
              'identicalCropBytes': True, 'mergeInputQuestions': 2000, 'mergeMedianMs': merge_ms}
    content = json.dumps(report, indent=2) + '\n'
    if args.output:
        args.output.write_text(content)
    print(content, end='')


if __name__ == '__main__':
    main()
