import { useEvent } from 'expo';
import { Image } from 'expo-image';
import { useFocusEffect } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import { memo, useCallback, useMemo, useState } from 'react';
import { StyleSheet } from 'react-native';
import { Alert } from 'heroui-native/alert';
import { Button } from 'heroui-native/button';
import { Chip } from 'heroui-native/chip';
import { Spinner } from 'heroui-native/spinner';
import { Surface } from 'heroui-native/surface';
import { Typography } from 'heroui-native/text';

import { useLanguage } from '@/language';
import { metadataText } from '@/logic';
import type { ContentBlock, MediaAttachment } from '@/types';

const MAX_TABLE_ROWS = 50;
const MAX_TABLE_COLUMNS = 12;

function mediaAspectRatio(media: MediaAttachment) {
  if (!media.width || !media.height) return 4 / 3;
  return Math.min(3, Math.max(1 / 2, media.width / media.height));
}

function MediaError({ message }: { message: string }) {
  return (
    <Alert status="warning">
      <Alert.Indicator />
      <Alert.Content><Alert.Description>{message}</Alert.Description></Alert.Content>
    </Alert>
  );
}

function MediaImage({ media, description }: { media: MediaAttachment; description: string }) {
  const { tr } = useLanguage();
  const [failed, setFailed] = useState(false);

  if (failed) {
    return <MediaError message={tr(`Image unavailable: ${media.file_name}`, `图片无法读取：${media.file_name}`)} />;
  }
  return (
    <Image
      source={{ uri: media.uri }}
      style={[styles.media, { aspectRatio: mediaAspectRatio(media) }]}
      contentFit="contain"
      recyclingKey={media.uri}
      cachePolicy="memory-disk"
      transition={200}
      accessible
      accessibilityLabel={description}
      accessibilityIgnoresInvertColors
      onError={() => setFailed(true)}
    />
  );
}

function LoadedVideo({ media, description }: { media: MediaAttachment; description: string }) {
  const { tr } = useLanguage();
  const player = useVideoPlayer({
    uri: media.uri,
    metadata: { title: media.file_name },
  });
  useFocusEffect(useCallback(() => () => {
    try {
      player.pause();
    } catch {
      // useVideoPlayer may already have released the native object during unmount.
    }
  }, [player]));
  const { status, error } = useEvent(player, 'statusChange', { status: player.status });

  if (status === 'error') {
    return (
      <MediaError
        message={tr(
          `Video unavailable: ${error?.message ?? media.file_name}`,
          `视频无法读取：${error?.message ?? media.file_name}`,
        )}
      />
    );
  }
  return (
    <>
      {status === 'loading' ? (
        <Spinner
          accessibilityRole="progressbar"
          accessibilityLabel={tr('Loading video', '正在加载视频')}
        />
      ) : null}
      <VideoView
        player={player}
        style={[styles.media, { aspectRatio: mediaAspectRatio(media) }]}
        nativeControls
        contentFit="contain"
        fullscreenOptions={{ enable: true }}
        accessibilityLabel={description}
      />
    </>
  );
}

function MediaVideo({ media, description }: { media: MediaAttachment; description: string }) {
  const { tr } = useLanguage();
  const [loaded, setLoaded] = useState(false);

  return loaded ? (
    <>
      <LoadedVideo media={media} description={description} />
      <Button variant="ghost" onPress={() => setLoaded(false)}>
        {tr('Close video', '关闭视频')}
      </Button>
    </>
  ) : (
    <Button variant="secondary" onPress={() => setLoaded(true)}>
      {tr('Load video', '加载视频')}
    </Button>
  );
}

export const MediaAttachmentView = memo(function MediaAttachmentView({ media }: { media: MediaAttachment }) {
  const { tr } = useLanguage();
  const annotation = metadataText(media.metadata_json);
  const description = annotation || media.file_name || tr('Question media', '题目媒体');
  const isImage = media.mime_type.startsWith('image/');
  const isVideo = media.mime_type.startsWith('video/');

  return (
    <Surface className="gap-2 overflow-hidden" variant="tertiary">
      {isImage ? <MediaImage key={media.uri} media={media} description={description} /> : null}
      {isVideo ? <MediaVideo media={media} description={description} /> : null}
      {!isImage && !isVideo ? (
        <MediaError message={tr(`Unsupported media: ${media.file_name}`, `不支持的媒体：${media.file_name}`)} />
      ) : null}
      <Typography type="body-sm" selectable>{media.file_name}</Typography>
      {annotation && annotation !== media.file_name ? (
        <Typography type="body-sm" color="muted">{annotation}</Typography>
      ) : null}
    </Surface>
  );
});

export const MediaAttachments = memo(function MediaAttachments({ media }: { media: MediaAttachment[] }) {
  if (!media.length) return null;
  return (
    <Surface className="gap-3 rounded-none p-0" variant="transparent">
      {media.map((item, index) => (
        <MediaAttachmentView key={`${item.id}-${item.uri}-${index}`} media={item} />
      ))}
    </Surface>
  );
});

export function parseTableRows(content: string) {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, MAX_TABLE_ROWS)
    .map((line) => {
      const delimiter = line.includes('|') ? '|' : line.includes('\t') ? '\t' : ',';
      return line.split(delimiter).slice(0, MAX_TABLE_COLUMNS).map((cell) => cell.trim());
    });
}

function TableBlock({ content }: { content: string }) {
  const rows = useMemo(() => parseTableRows(content), [content]);
  if (!rows.length) return null;
  const columnCount = Math.max(...rows.map((row) => row.length));
  return (
    <Surface className="gap-1" variant="tertiary" accessibilityLabel={content}>
      {rows.map((row, rowIndex) => (
        <Surface
          className="flex-row gap-1 rounded-none p-0"
          variant="transparent"
          key={`${row.join('\u0000')}-${rowIndex}`}
        >
          {Array.from({ length: columnCount }, (_, columnIndex) => (
            <Surface className="min-w-0 flex-1" variant={rowIndex === 0 ? 'secondary' : 'tertiary'} key={columnIndex}>
              <Typography type="body-sm" weight={rowIndex === 0 ? 'semibold' : 'normal'}>
                {row[columnIndex] ?? ''}
              </Typography>
            </Surface>
          ))}
        </Surface>
      ))}
    </Surface>
  );
}

function sourceLabel(kind: ContentBlock['kind'], tr: (english: string, simplifiedChinese: string) => string) {
  if (kind === 'formula') return tr('Formula source', '公式源码');
  if (kind === 'markdown') return 'Markdown';
  if (kind === 'html') return tr('HTML source', 'HTML 源码');
  if (kind === 'mathml') return 'MathML';
  return null;
}

export const ContentBlockView = memo(function ContentBlockView({ block }: { block: ContentBlock }) {
  const { tr } = useLanguage();
  const hasMedia = Boolean(block.media_uri && block.media_mime_type);
  const media: MediaAttachment | null = hasMedia ? {
    id: block.media_asset_id ?? 0,
    file_name: block.media_file_name || tr('Content image', '内容图片'),
    uri: block.media_uri!,
    mime_type: block.media_mime_type!,
    metadata_json: block.metadata_json,
  } : null;
  const content = block.content.trim();
  const showCaption = content && content !== block.media_file_name;
  const label = sourceLabel(block.kind, tr);

  if (!content && !media) return null;
  if (block.kind === 'table' && !media) return <TableBlock content={content} />;

  return (
    <Surface className="gap-2 rounded-none p-0" variant="transparent">
      {media ? <MediaAttachmentView media={media} /> : null}
      {showCaption || !media ? (
        <>
          {label ? <Chip size="sm" variant="soft">{label}</Chip> : null}
          <Typography selectable>{content}</Typography>
        </>
      ) : null}
    </Surface>
  );
});

export const ContentBlocks = memo(function ContentBlocks({ blocks }: { blocks: ContentBlock[] }) {
  if (!blocks.length) return null;
  return (
    <Surface className="gap-3 rounded-none p-0" variant="transparent">
      {blocks.map((block, index) => (
        <ContentBlockView key={`${block.id ?? block.sort_order}-${index}`} block={block} />
      ))}
    </Surface>
  );
});

const styles = StyleSheet.create({
  media: {
    width: '100%',
    minHeight: 160,
    maxHeight: 480,
    backgroundColor: 'transparent',
  },
});
