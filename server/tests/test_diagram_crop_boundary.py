"""Temporary draft self-checks; no service/source files or provider calls."""
from io import BytesIO

import pytest
from PIL import Image, ImageDraw

from practiq_ai.graphs import vision

BOX = [.2, .25, .8, .75]  # [40, 40, 160, 120] at 200x160; right/bottom excluded.


def image_bytes(image):
    out = BytesIO()
    image.save(out, format='PNG')
    return out.getvalue()


@pytest.mark.parametrize('line', [
    (30, 70, 50, 70),  # left, one-pixel stroke
    (150, 70, 170, 70),  # right
    (70, 30, 70, 50),  # top
    (70, 110, 70, 130),  # bottom
    (150, 60, 170, 80),  # diagonal eight-connected stroke
])
def test_white_diagram_rejects_ink_crossing_each_boundary(line):
    with Image.new('RGB', (200, 160), 'white') as image:
        ImageDraw.Draw(image).line(line, fill='black')
        assert vision.diagram_crop_has_cut_ink(image, BOX)
        assert vision.checked_crop_figures(image_bytes(image), [BOX], ['diagram']) == [(None, True)]


def test_enclosed_ink_and_unrelated_outside_ink_are_retained():
    with Image.new('RGB', (200, 160), 'white') as image:
        draw = ImageDraw.Draw(image)
        draw.rectangle((60, 55, 120, 100), outline='black', width=2)
        draw.line((163, 60, 175, 60), fill='black', width=2)
        assert not vision.diagram_crop_has_cut_ink(image, BOX)
        payload = image_bytes(image)
        crop, rejected = vision.checked_crop_figures(payload, [BOX], ['diagram'])[0]
        assert not rejected and crop == vision.crop_figures(payload, [BOX])[0]


def test_inside_only_pixel_is_not_a_crossing():
    with Image.new('RGB', (200, 160), 'white') as image:
        image.putpixel((159, 70), (0, 0, 0))
        assert not vision.diagram_crop_has_cut_ink(image, BOX)


def test_nonwhite_background_is_outside_this_guard():
    with Image.new('RGB', (200, 160), (220, 220, 220)) as image:
        ImageDraw.Draw(image).line((150, 70, 170, 70), fill='black', width=3)
        crop, rejected = vision.checked_crop_figures(image_bytes(image), [BOX], ['diagram'])[0]
        assert not rejected and crop is not None


@pytest.mark.parametrize('kind', ['image', 'table', 'chart', 'qr_code', None])
def test_other_kinds_and_unguarded_preview_preserve_original_crops(kind):
    with Image.new('RGB', (200, 160), 'white') as image:
        ImageDraw.Draw(image).line((150, 70, 170, 70), fill='black', width=3)
        payload = image_bytes(image)
        expected = vision.crop_figures(payload, [BOX])[0]
        crop, rejected = vision.checked_crop_figures(payload, [BOX], [kind])[0]
        assert expected is not None and crop == expected and not rejected


def test_full_source_has_no_unobservable_external_boundary():
    with Image.new('RGB', (200, 160), 'white') as image:
        ImageDraw.Draw(image).line((190, 70, 199, 70), fill='black', width=3)
        assert not vision.diagram_crop_has_cut_ink(image, [0, 0, 1, 1])


def test_whole_source_has_outside_ink_that_a_crop_alone_cannot_observe():
    with Image.new('RGB', (200, 160), 'white') as image:
        ImageDraw.Draw(image).line((150, 70, 170, 70), fill='black')
        assert image.getpixel((159, 70)) == image.getpixel((160, 70)) == (0, 0, 0)
        assert vision.diagram_crop_has_cut_ink(image, BOX)
        with image.crop((40, 40, 160, 120)) as cropped:
            assert not vision.diagram_crop_has_cut_ink(cropped, [0, 0, 1, 1])


def test_checked_batch_decodes_once_and_preserves_failure_positions(monkeypatch):
    with Image.new('RGB', (200, 160), 'white') as image:
        ImageDraw.Draw(image).line((150, 70, 170, 70), fill='black', width=3)
        payload = image_bytes(image)
    opened = []
    original_open = vision.Image.open

    def counted_open(*args, **kwargs):
        opened.append(1)
        return original_open(*args, **kwargs)

    monkeypatch.setattr(vision.Image, 'open', counted_open)
    crops = vision.checked_crop_figures(payload, [BOX, [1, 1, 0, 0], BOX], ['diagram', 'diagram', 'image'])
    assert crops[0] == (None, True) and crops[1] == (None, False)
    assert crops[2][0] is not None and crops[2][1] is False
    assert len(opened) == 1
    assert vision.checked_crop_figures(b'not an image', [BOX], ['diagram']) == [(None, False)]
