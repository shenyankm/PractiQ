import { memo } from 'react';
import { Button } from 'heroui-native/button';
import { Card } from 'heroui-native/card';
import { Chip } from 'heroui-native/chip';
import { Description } from 'heroui-native/description';
import { Input } from 'heroui-native/input';
import { Label } from 'heroui-native/label';
import { RadioGroup } from 'heroui-native/radio-group';
import { TextArea } from 'heroui-native/text-area';
import { TextField } from 'heroui-native/text-field';
import { Typography } from 'heroui-native/text';

import { ContentBlockView } from '@/components/question-content';
import { useLanguage } from '@/language';
import { metadataText, withMetadataText } from '@/logic';
import { CONTENT_BLOCK_TYPES } from '@/types';
import type { ContentBlock, MediaAttachment } from '@/types';

type UpdateContentBlocks = (update: (current: ContentBlock[]) => ContentBlock[]) => void;

export const ContentBlockEditor = memo(function ContentBlockEditor({
  blocks,
  media,
  editing,
  owner,
  onChange,
}: {
  blocks: ContentBlock[];
  media: MediaAttachment[];
  editing: boolean;
  owner: 'question' | 'group';
  onChange: UpdateContentBlocks;
}) {
  const { tr } = useLanguage();
  const labels: Record<ContentBlock['kind'], string> = {
    text: tr('Text', '文本'),
    formula: tr('Formula', '公式'),
    image: tr('Image', '图片'),
    table: tr('Table', '表格'),
    markdown: 'Markdown',
    html: 'HTML',
    chart: tr('Chart', '图表'),
    qrcode: tr('QR code', 'QR 码'),
    mathml: 'MathML',
  };
  const update = (index: number, patch: Partial<ContentBlock>) => onChange((current) => (
    current.map((block, blockIndex) => blockIndex === index ? { ...block, ...patch } : block)
  ));
  const move = (index: number, direction: -1 | 1) => onChange((current) => {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= current.length) return current;
    const next = [...current];
    [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
    return next.map((block, sort_order) => ({ ...block, sort_order }));
  });
  const addButton = editing ? (
    <Button
      variant="ghost"
      onPress={() => onChange((current) => [
        ...current,
        { kind: 'text', content: '', sort_order: current.length },
      ])}
    >
      {tr('Add content block', '添加内容块')}
    </Button>
  ) : null;
  const accessibilityLabel = owner === 'group'
    ? tr('Accessible description (for VoiceOver)', '辅助说明（供 VoiceOver）')
    : tr('Accessibility description (for VoiceOver)', '辅助说明（供 VoiceOver）');

  return (
    <>
      {owner === 'question' ? addButton : null}
      {blocks.length ? blocks.map((block, index) => (
        <Card className="gap-3" key={block.id ?? index}>
          <Card.Title>{tr(`Content block ${index + 1}`, `内容块 ${index + 1}`)}</Card.Title>
          {editing ? (
            <RadioGroup
              value={block.kind}
              accessibilityLabel={tr(`Content block ${index + 1} type`, `内容块 ${index + 1} 类型`)}
              onValueChange={(value) => {
                const kind = value as ContentBlock['kind'];
                update(index, ['image', 'chart', 'qrcode'].includes(kind)
                  ? { kind }
                  : {
                    kind,
                    media_asset_id: null,
                    media_uri: null,
                    media_mime_type: null,
                    media_file_name: null,
                  });
              }}
            >
              {CONTENT_BLOCK_TYPES.map((kind) => (
                <RadioGroup.Item key={kind} value={kind}>{labels[kind]}</RadioGroup.Item>
              ))}
            </RadioGroup>
          ) : <Chip color="default" variant="soft">{labels[block.kind] ?? block.kind}</Chip>}
          {editing ? (
            <>
              <TextField>
                <Label>{tr('Content', '内容')}</Label>
                <TextArea
                  accessibilityLabel={tr('Content', '内容')}
                  value={block.content}
                  onChangeText={(content) => update(index, { content })}
                  maxLength={50_000}
                />
                {block.kind === 'table' ? (
                  <Description>{tr('Enter one record per line and separate columns with vertical bars, tabs, or commas.', '每行一条记录，以竖线、Tab 或逗号分列。')}</Description>
                ) : block.kind === 'chart' ? (
                  <Description>{tr('Use JSON, or enter one "name,value" pair per line.', '使用 JSON，或每行“名称,数值”。')}</Description>
                ) : null}
              </TextField>
              <TextField>
                <Label>{accessibilityLabel}</Label>
                <Input
                  accessibilityLabel={accessibilityLabel}
                  value={metadataText(block.metadata_json)}
                  onChangeText={(value) => update(index, { metadata_json: withMetadataText(block.metadata_json, value) })}
                  maxLength={500}
                />
              </TextField>
            </>
          ) : <ContentBlockView block={block} />}
          {editing && ['image', 'chart', 'qrcode'].includes(block.kind) ? (
            media.length ? (
              <RadioGroup
                value={block.media_asset_id ? String(block.media_asset_id) : undefined}
                accessibilityLabel={owner === 'group'
                  ? tr('Choose a question group image', '选择题组图片')
                  : tr('Choose content block image', '选择内容块图片')}
                onValueChange={(value) => {
                  const selected = media.find((item) => item.id === Number(value));
                  if (!selected) return;
                  update(index, {
                    media_asset_id: selected.id,
                    media_uri: selected.uri,
                    media_mime_type: selected.mime_type,
                    media_file_name: selected.file_name,
                    content: block.content || selected.file_name,
                  });
                }}
              >
                {media.map((item) => (
                  <RadioGroup.Item key={item.id} value={String(item.id)}>{item.file_name}</RadioGroup.Item>
                ))}
              </RadioGroup>
            ) : owner === 'group' ? (
              <Typography color="muted">{tr('Import a question group image first.', '先导入一张题组图片。')}</Typography>
            ) : null
          ) : null}
          {editing ? (
            <>
              <Button variant="ghost" isDisabled={index === 0} onPress={() => move(index, -1)}>{tr('Move up', '上移')}</Button>
              <Button variant="ghost" isDisabled={index === blocks.length - 1} onPress={() => move(index, 1)}>{tr('Move down', '下移')}</Button>
              <Button variant="danger" onPress={() => onChange((current) => current.filter((_, blockIndex) => blockIndex !== index))}>
                {tr('Delete content block', '删除内容块')}
              </Button>
              {block.content.trim() || block.media_uri ? (
                <>
                  <Typography type="body-sm" weight="semibold">{tr('Preview', '预览')}</Typography>
                  <ContentBlockView block={block} />
                </>
              ) : null}
            </>
          ) : null}
        </Card>
      )) : <Typography color="muted">{tr('No content blocks.', '暂无内容块。')}</Typography>}
      {owner === 'group' ? addButton : null}
    </>
  );
});
