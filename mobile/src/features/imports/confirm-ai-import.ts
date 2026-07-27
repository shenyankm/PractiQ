import { Alert as NativeAlert } from 'react-native';

import type { AiImportConfirmationDetails } from './runtime';

type Translate = (english: string, chinese: string) => string;

export function confirmAiImport(
  details: AiImportConfirmationDetails,
  tr: Translate,
  retry = false,
) {
  return new Promise<boolean>((resolve) => NativeAlert.alert(
    retry
      ? tr('Send document content to AI again?', '再次发送文档内容到 AI？')
      : tr('Send document content to AI?', '发送文档内容到 AI？'),
    (retry
      ? tr(
        `Recipient: PractiQ cloud service\nEndpoint: ${details.endpoint}\n\nThe full text extracted from "${details.fileName}" (source file ${Math.ceil(details.size / 1024)} KB) will be sent again to retry document parsing.`,
        `接收方：PractiQ 云端服务\n地址：${details.endpoint}\n\n将再次发送从“${details.fileName}”提取的全文（源文件 ${Math.ceil(details.size / 1024)} KB），用于重试文档解析。`,
      )
      : tr(
        `Recipient: PractiQ cloud service\nEndpoint: ${details.endpoint}\n\nData sent: the full text extracted from "${details.fileName}" (source file ${Math.ceil(details.size / 1024)} KB), to parse questions. Your login credential is used only to authenticate the request.`,
        `接收方：PractiQ 云端服务\n地址：${details.endpoint}\n\n将发送：从“${details.fileName}”提取的全文（源文件 ${Math.ceil(details.size / 1024)} KB），用于解析试题。登录凭证仅用于请求鉴权。`,
      )),
    [
      { text: tr("Don't send", '不发送'), style: 'cancel', onPress: () => resolve(false) },
      {
        text: retry ? tr('Retry', '确认重试') : tr('Send', '确认发送'),
        onPress: () => resolve(true),
      },
    ],
    { cancelable: true, onDismiss: () => resolve(false) },
  ));
}
