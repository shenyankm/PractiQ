"""A crossing label needs two independent Tencent associations, never nearby guesses."""
from copy import deepcopy
from io import BytesIO

import pytest
from PIL import Image, ImageDraw
from pydantic import ValidationError

from practiq_ai.contracts import VisualElement
from practiq_ai.graphs import vision
from practiq_ai.tencent_bundle import _label_crop_bbox


def element(box, text, *, figure=False):
    x0, y0, x1, y1 = box
    polygon = {key: {'x': x, 'y': y} for key, x, y in [
        ('left_top', x0, y0), ('right_top', x1, y0), ('left_bottom', x0, y1), ('right_bottom', x1, y1)]}
    return {'polygon': polygon, 'figure_info': {'text_info': {'content': text}}} if figure else {'polygon': polygon, 'text_info': {'content': text}}


def test_crossing_source_label_is_recovered_without_changing_original_figure_or_cut_guard():
    figure = element((40, 40, 160, 120), '3\n4\n5', figure=True)
    label = element((75, 113, 90, 125), '3')
    saved = deepcopy([figure, label])
    crop = _label_crop_bbox(figure, [figure, label], 200, 160)
    assert crop is not None
    assert crop == [.2, .25, .8, 125 / 160]
    assert [figure, label] == saved
    buffer = BytesIO()
    with Image.new('RGB', (200, 160), 'white') as image:
        ImageDraw.Draw(image).line((80, 115, 80, 123), fill='black', width=2)
        image.save(buffer, 'PNG')
    assert vision.checked_crop_figures(buffer.getvalue(), [[.2, .25, .8, .75]], ['diagram']) == [(None, True)]
    data, rejected = vision.checked_crop_figures(buffer.getvalue(), [crop], ['diagram'])[0]
    assert data is not None and not rejected
    value = VisualElement(kind='diagram', description='Source figure', bbox=[.2, .25, .8, .75], cropBbox=crop)
    assert value.bbox == [.2, .25, .8, .75] and value.cropBbox == crop


@pytest.mark.parametrize('defect', ['unidentified', 'detached', 'ambiguous', 'answer_nearby', 'large', 'invalid', 'non_text'])
def test_uncertain_or_answer_adjacent_labels_do_not_expand_bounds(defect):
    figure = element((40, 40, 160, 120), '3', figure=True)
    label = element((75, 113, 90, 125), '3')
    elements = [figure, label]
    if defect == 'unidentified':
        figure['figure_info']['text_info']['content'] = '5'
    elif defect == 'detached':
        elements[1] = element((75, 122, 90, 130), '3')
    elif defect == 'ambiguous':
        elements.append(element((95, 113, 110, 125), '3'))
    elif defect == 'answer_nearby':
        elements.append(element((45, 121, 70, 125), 'Answer: 42'))
    elif defect == 'large':
        elements[1] = element((75, 113, 190, 159), '3')
    elif defect == 'invalid':
        elements[1]['polygon'] = {}
    else:
        elements[1]['text_info']['content'] = 3
    assert _label_crop_bbox(figure, elements, 200, 160) is None


@pytest.mark.parametrize('crop', [[0, 0, 2, 1], [.3, .25, .8, .75], [0, 0, 0, 0]])
def test_crop_provenance_must_have_valid_bounds_containing_fixed_figure(crop):
    with pytest.raises(ValidationError):
        VisualElement(kind='diagram', description='Source figure', bbox=[.2, .25, .8, .75], cropBbox=crop)
