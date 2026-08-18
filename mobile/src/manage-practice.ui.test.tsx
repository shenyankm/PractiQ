// Render tests for the manage/settings/import/practice screens in screens.tsx.
// Same stub strategy as screens.ui.test.tsx: heroui subpaths and native/data
// modules are mocked so interactions are scriptable and fast.
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

jest.mock('heroui-native/alert', () => {
  const { Text, View } = require('react-native');
  const { Textify } = require('./test-utils/textify');
  const Alert: any = ({ children }: any) => <View><Textify>{children}</Textify></View>;
  Alert.Indicator = () => <View />;
  Alert.Content = ({ children }: any) => <View>{children}</View>;
  Alert.Title = ({ children }: any) => <Text>{children}</Text>;
  return { Alert };
});
jest.mock('heroui-native/button', () => {
  const { Pressable } = require('react-native');
  const { Textify } = require('./test-utils/textify');
  return {
    Button: ({ onPress, isDisabled, children }: any) => (
      <Pressable accessibilityRole="button" disabled={!!isDisabled} onPress={isDisabled ? undefined : onPress}><Textify>{children}</Textify></Pressable>
    ),
  };
});
jest.mock('heroui-native/card', () => {
  const { Text, View } = require('react-native');
  const { Textify } = require('./test-utils/textify');
  const Card: any = ({ children }: any) => <View><Textify>{children}</Textify></View>;
  Card.Title = ({ children }: any) => <Text>{children}</Text>;
  Card.Description = ({ children }: any) => <Text>{children}</Text>;
  return { Card };
});
jest.mock('heroui-native/chip', () => {
  const { Text, View } = require('react-native');
  return { Chip: ({ children }: any) => <View><Text>{children}</Text></View> };
});
jest.mock('heroui-native/input', () => {
  const { TextInput } = require('react-native');
  return { Input: (props: any) => <TextInput {...props} /> };
});
jest.mock('heroui-native/label', () => {
  const { Text } = require('react-native');
  return { Label: ({ children }: any) => <Text>{children}</Text> };
});
jest.mock('heroui-native/spinner', () => {
  const { Text, View } = require('react-native');
  return { Spinner: ({ accessibilityLabel }: any) => <View><Text>{accessibilityLabel || 'loading'}</Text></View> };
});
jest.mock('heroui-native/surface', () => {
  const { View } = require('react-native');
  const { Textify } = require('./test-utils/textify');
  return { Surface: ({ children }: any) => <View><Textify>{children}</Textify></View> };
});
jest.mock('heroui-native/text', () => {
  const { Text } = require('react-native');
  const Typography: any = ({ children }: any) => <Text>{children}</Text>;
  Typography.Heading = Typography;
  return { Typography };
});
jest.mock('heroui-native/text-field', () => {
  const { View } = require('react-native');
  const { Textify } = require('./test-utils/textify');
  return { TextField: ({ children }: any) => <View><Textify>{children}</Textify></View> };
});

const mockUseCachedResource = jest.fn<any, any[]>();
const mockUseCloudAuth = jest.fn<any, any[]>();
const mockApiRequest = jest.fn<any, any[]>();
const mockMutateOrQueue = jest.fn<any, any[]>();
const mockStreamImportJobEvents = jest.fn<any, any[]>();
const mockUploadImport = jest.fn<any, any[]>();
const mockCreateMutationKey = jest.fn<any, any[]>(() => 'mutation-key');
const mockEnqueueMutation = jest.fn<any, any[]>();
const mockReadResource = jest.fn<any, any[]>();
const mockWriteResource = jest.fn<any, any[]>();
const mockUseLocalSearchParams = jest.fn<any, any[]>(() => ({}));

jest.mock('expo-router', () => ({
  router: { push: jest.fn<any, any[]>(), replace: jest.fn<any, any[]>() },
  useLocalSearchParams: (...args: unknown[]) => mockUseLocalSearchParams(...args),
}));
jest.mock('expo-document-picker', () => ({
  getDocumentAsync: jest.fn<any, any[]>(async () => ({ canceled: true })),
}));
jest.mock('expo-file-system', () => ({
  Directory: class {
    create() { /* no-op */ }
  },
  File: class {
    uri = 'file:///mock';
    exists = false;
    constructor(..._args: unknown[]) { /* no-op */ }
    async copy() {
      this.exists = true;
    }
    delete() {
      this.exists = false;
    }
  },
  Paths: { document: '/documents' },
}));
jest.mock('./cloud', () => ({ CLOUD_API_URL: 'http://cloud.test' }));
jest.mock('./practiq/api', () => ({
  ApiError: class extends Error {
    code = '';
    status = 0;
    constructor(message = '', code = '', status = 0) {
      super(message);
      this.code = code;
      this.status = status;
    }
  },
  apiRequest: (...args: unknown[]) => mockApiRequest(...args),
  mutateOrQueue: (...args: unknown[]) => mockMutateOrQueue(...args),
  streamImportJobEvents: (...args: unknown[]) => mockStreamImportJobEvents(...args),
  uploadImport: (...args: unknown[]) => mockUploadImport(...args),
}));
jest.mock('./practiq/cache', () => ({
  createMutationKey: (...args: unknown[]) => mockCreateMutationKey(...args),
  enqueueMutation: (...args: unknown[]) => mockEnqueueMutation(...args),
  readResource: (...args: unknown[]) => mockReadResource(...args),
  writeResource: (...args: unknown[]) => mockWriteResource(...args),
}));
jest.mock('./practiq/auth', () => ({ useCloudAuth: (...args: unknown[]) => mockUseCloudAuth(...args) }));
jest.mock('./practiq/mirror', () => ({
  bankGroupsResourceMirror: jest.fn<any, any[]>(),
  bankItemsResourceMirror: jest.fn<any, any[]>(),
  bankResourceMirror: jest.fn<any, any[]>(),
  banksResourceMirror: jest.fn<any, any[]>(),
  questionDetailResourceMirror: jest.fn<any, any[]>(),
  questionTypesResourceMirror: jest.fn<any, any[]>(),
  sessionsResourceMirror: jest.fn<any, any[]>(),
  subjectsResourceMirror: jest.fn<any, any[]>(),
  upsertMediaAsset: jest.fn<any, any[]>(),
}));
jest.mock('./practiq/use-resource', () => ({
  useCachedResource: (...args: unknown[]) => mockUseCachedResource(...args),
}));
const mockUseLanguage = jest.fn<any, any[]>(() => ({
  tr: (_en: string, zh: string) => zh ?? _en,
  language: 'zh-CN',
  setLanguage: jest.fn<any, any[]>(async () => undefined),
}));
jest.mock('./language', () => ({ useLanguage: () => mockUseLanguage() }));

import {
  AISettingsScreen,
  ImportDetailScreen,
  ImportsScreen,
  ManageBankScreen,
  PracticeSessionScreen,
  PracticeSetupScreen,
  SettingsScreen,
} from './practiq/screens';

function resource(overrides: Record<string, unknown> = {}) {
  return {
    data: [],
    loading: false,
    refreshing: false,
    loadingMore: false,
    hasMore: false,
    error: '',
    reload: jest.fn<any, any[]>(async () => undefined),
    loadMore: jest.fn<any, any[]>(async () => undefined),
    update: jest.fn<any, any[]>(async () => undefined),
    ...overrides,
  };
}

const resources = new Map<string, ReturnType<typeof resource>>();

function defaultAuth(overrides: Record<string, unknown> = {}) {
  return {
    user: null,
    session: null,
    hasPro: false,
    sync: { pending: 0, failed: 0, running: false },
    purchasePro: jest.fn<any, any[]>(async () => undefined),
    updateProfile: jest.fn<any, any[]>(async () => undefined),
    signOut: jest.fn<any, any[]>(async () => undefined),
    restorePurchases: jest.fn<any, any[]>(async () => undefined),
    manageSubscription: jest.fn<any, any[]>(async () => undefined),
    synchronize: jest.fn<any, any[]>(async () => undefined),
    ...overrides,
  };
}

function bankData(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `题库${id}`,
    description: null,
    subject: 'math',
    total_count: 10,
    is_public: false,
    is_owner: true,
    is_favorite: false,
    pending: false,
    ...overrides,
  };
}

function itemData(id: number, overrides: Record<string, unknown> = {}) {
  return {
    question_id: id,
    group_id: null,
    stem: `题干${id}`,
    answer_mode: 'short_answer',
    choice_variant: null,
    question_type_id: 't1',
    question_status: 'active',
    bank_link_status: 'active',
    options: [],
    ...overrides,
  };
}

const ApiError = () => jest.requireMock('./practiq/api').ApiError;
const router = () => jest.requireMock('expo-router').router;
const documentPicker = () => jest.requireMock('expo-document-picker').getDocumentAsync as jest.Mock;

function setupManageBank() {
  mockUseLocalSearchParams.mockReturnValue({ bankId: '5' });
  resources.set('bank:5', resource({ data: bankData(5, { name: '历史', subject: 'history' }) }));
  resources.set('bank:5:manage-items', resource());
  resources.set('bank:5:groups', resource());
  resources.set('types:history', resource({ data: [{ type_id: 't1', display_name: '简答', default_answer_mode: 'short_answer' }] }));
}

beforeEach(() => {
  resources.clear();
  mockUseCachedResource.mockImplementation((key: string) => resources.get(key) ?? resource());
  mockUseCloudAuth.mockReturnValue(defaultAuth());
  mockUseLanguage.mockReturnValue({
    tr: (_en: string, zh: string) => zh ?? _en,
    language: 'zh-CN',
    setLanguage: jest.fn<any, any[]>(async () => undefined),
  });
  mockUseLocalSearchParams.mockReturnValue({});
  mockApiRequest.mockReset();
  mockApiRequest.mockResolvedValue({ provider: '', textModel: '', visionModel: null, configured: false });
  mockMutateOrQueue.mockReset();
  mockStreamImportJobEvents.mockReset();
  mockStreamImportJobEvents.mockResolvedValue(undefined);
  mockUploadImport.mockReset();
  mockCreateMutationKey.mockReturnValue('mutation-key');
  mockEnqueueMutation.mockReset();
  mockReadResource.mockReset();
  mockWriteResource.mockReset();
  router().push.mockClear();
  router().replace.mockClear();
});

describe('ManageBankScreen', () => {
  it('updates bank details', async () => {
    setupManageBank();
    const bankResource = resources.get('bank:5')!;
    mockMutateOrQueue.mockResolvedValue({ queued: true, data: null });
    const view = await render(<ManageBankScreen />);
    await waitFor(() => expect(view.container.queryAll((node: any) => node.type === 'TextInput')[0].props.value).toBe('历史'));
    await act(async () => {
      await fireEvent.changeText(view.container.queryAll((node: any) => node.type === 'TextInput')[0], '新名称');
    });
    await act(async () => {
      await fireEvent.press(view.getByText('保存题库资料'));
    });
    expect(mockMutateOrQueue).toHaveBeenCalledWith('/api/v1/banks/5', 'PATCH', {
      name: '新名称',
      description: null,
      isPublic: false,
    }, expect.anything());
    expect(bankResource.update).toHaveBeenCalledWith(expect.objectContaining({ name: '新名称', is_owner: true }));
    expect(view.getByText('修改已加入同步队列。')).toBeTruthy();
  });

  it('validates choice questions and queues a short-answer draft', async () => {
    mockUseLocalSearchParams.mockReturnValue({ bankId: '5' });
    resources.set('bank:5', resource({ data: bankData(5, { name: '历史', subject: 'history' }) }));
    resources.set('bank:5:manage-items', resource());
    resources.set('bank:5:groups', resource());
    resources.set('types:history', resource({ data: [{ type_id: 't1', display_name: '选择', default_answer_mode: 'choice' }] }));
    const view = await render(<ManageBankScreen />);
    await act(async () => {
      await fireEvent.changeText(view.container.queryAll((node: any) => node.type === 'TextInput')[2], '题干');
    });
    await act(async () => {
      await fireEvent.changeText(view.container.queryAll((node: any) => node.type === 'TextInput')[4], 'A');
    });
    await act(async () => {
      await fireEvent.press(view.getByText('保存草稿'));
    });
    expect(view.getByText('请至少添加两个选项并填写正确选项标签。')).toBeTruthy();
    await act(async () => {
      await fireEvent.press(view.getByText('简答'));
    });
    await act(async () => {
      await fireEvent.changeText(view.container.queryAll((node: any) => node.type === 'TextInput')[2], '新题干');
    });
    await act(async () => {
      await fireEvent.changeText(view.container.queryAll((node: any) => node.type === 'TextInput')[3], '参考答案');
    });
    mockMutateOrQueue.mockResolvedValue({ queued: true, data: null });
    await act(async () => {
      await fireEvent.press(view.getByText('保存草稿'));
    });
    expect(mockMutateOrQueue).toHaveBeenCalledWith('/api/v1/banks/5/questions', 'POST', expect.objectContaining({
      questionTypeId: 't1',
      answerMode: 'short_answer',
      stem: '新题干',
      answerPayload: { value: '参考答案' },
    }));
    expect(view.getByText('题目已加入同步队列。')).toBeTruthy();
    expect(resources.get('bank:5:manage-items')!.update).toHaveBeenCalledWith([expect.objectContaining({ question_id: expect.any(Number), question_status: 'draft' })]);
  });

  it('creates a group and publishes/archives/deletes with confirmation', async () => {
    setupManageBank();
    const groupsResource = resources.get('bank:5:groups')!;
    mockMutateOrQueue.mockResolvedValue({ queued: false, data: { id: 10 } });
    const view = await render(<ManageBankScreen />);
    await act(async () => {
      await fireEvent.changeText(view.container.queryAll((node: any) => node.type === 'TextInput')[4], '新组合');
    });
    await act(async () => {
      await fireEvent.press(view.getByText('创建组合题'));
    });
    expect(mockMutateOrQueue).toHaveBeenCalledWith('/api/v1/banks/5/groups', 'POST', {
      title: '新组合',
      instructions: null,
      contentMode: 'text_only',
      status: 'draft',
    });
    expect(groupsResource.reload).toHaveBeenCalled();
    // a draft group with a title renders publish + delete actions
    resources.set('bank:5:groups', resource({ data: [{ id: 10, title: '组合1', instructions: '', status: 'draft', question_count: 2 }] }));
    mockUseCachedResource.mockImplementation((key: string) => resources.get(key) ?? resource());
    const view2 = await render(<ManageBankScreen />);
    expect(view2.getByDisplayValue('组合1')).toBeTruthy();
    await act(async () => {
      await fireEvent.press(view2.getByText('发布组合题'));
    });
    expect(mockMutateOrQueue).toHaveBeenCalledWith('/api/v1/groups/10/publish', 'POST', undefined);
    await act(async () => {
      await fireEvent.press(view2.getByText('删除组合题'));
    });
    await act(async () => {
      await fireEvent.press(view2.getByText('确认删除组合题'));
    });
    expect(mockMutateOrQueue).toHaveBeenCalledWith('/api/v1/groups/10', 'DELETE', undefined);
    expect(view2.getByText('已更新。')).toBeTruthy();
  });
});

describe('SettingsScreen', () => {
  it('shows membership and saves the profile with a password change', async () => {
    const updateProfile = jest.fn<any, any[]>(async () => undefined);
    const auth = defaultAuth({ user: { id: 1, username: 'alice', email: 'a@b.c' }, hasPro: false, updateProfile });
    mockUseCloudAuth.mockReturnValue(auth);
    const view = await render(<SettingsScreen />);
    expect(view.getByText('FREE')).toBeTruthy();
    await waitFor(() => expect(view.container.queryAll((node: any) => node.type === 'TextInput')[0].props.value).toBe('alice'));
    const inputs = view.container.queryAll((node: any) => node.type === 'TextInput');
    await act(async () => {
      await fireEvent.changeText(inputs[2], 'old-pass');
    });
    await act(async () => {
      await fireEvent.changeText(inputs[3], 'new-pass');
    });
    await act(async () => {
      await fireEvent.press(view.getByText('保存账号资料'));
    });
    expect(updateProfile).toHaveBeenCalledWith({
      username: 'alice',
      email: 'a@b.c',
      currentPassword: 'old-pass',
      newPassword: 'new-pass',
    });
    expect(view.getByText('账号资料已更新。')).toBeTruthy();
  });

  it('signs out and syncs with retry when failures exist', async () => {
    const signOut = jest.fn<any, any[]>(async () => undefined);
    const synchronize = jest.fn<any, any[]>(async () => undefined);
    mockUseCloudAuth.mockReturnValue(defaultAuth({
      user: { id: 1, username: 'alice', email: '' },
      sync: { pending: 3, failed: 1, running: false },
      signOut,
      synchronize,
    }));
    const view = await render(<SettingsScreen />);
    expect(view.getByText('3 项待同步，1 项需要处理')).toBeTruthy();
    await act(async () => {
      await fireEvent.press(view.getByText('立即同步'));
    });
    expect(synchronize).toHaveBeenCalledWith(true);
    await act(async () => {
      await fireEvent.press(view.getByText('退出登录'));
    });
    expect(signOut).toHaveBeenCalled();
    expect(router().replace).toHaveBeenCalledWith('/sign-in');
  });

  it('switches the language and manages PRO billing', async () => {
    const setLanguage = jest.fn<any, any[]>(async () => undefined);
    mockUseLanguage.mockReturnValue({ tr: (_en: string, zh: string) => zh ?? _en, language: 'en', setLanguage });
    const purchasePro = jest.fn<any, any[]>(async () => undefined);
    mockUseCloudAuth.mockReturnValue(defaultAuth({ hasPro: false, purchasePro }));
    const view = await render(<SettingsScreen />);
    await act(async () => {
      await fireEvent.press(view.getByText('简体中文'));
    });
    expect(setLanguage).toHaveBeenCalledWith('zh-CN');
    await act(async () => {
      await fireEvent.press(view.getByText('升级为 PRO'));
    });
    expect(purchasePro).toHaveBeenCalled();
  });
});

describe('AISettingsScreen', () => {
  it('requires PRO and offers the upgrade path', async () => {
    const purchasePro = jest.fn<any, any[]>(async () => undefined);
    mockUseCloudAuth.mockReturnValue(defaultAuth({ hasPro: false, purchasePro }));
    const view = await render(<AISettingsScreen />);
    expect(view.getByText('需要 PRO')).toBeTruthy();
    await act(async () => {
      await fireEvent.press(view.getByText('升级为 PRO'));
    });
    expect(purchasePro).toHaveBeenCalled();
  });

  it('loads, saves and deletes the LLM config for pro users', async () => {
    mockUseCloudAuth.mockReturnValue(defaultAuth({ hasPro: true }));
    mockApiRequest.mockResolvedValue({ provider: 'dashscope', textModel: 'qwen', visionModel: null, configured: true });
    const view = await render(<AISettingsScreen />);
    await waitFor(() => expect(view.getByText('已配置')).toBeTruthy());
    const inputs = view.container.queryAll((node: any) => node.type === 'TextInput');
    await act(async () => {
      await fireEvent.changeText(inputs[0], 'sk-test');
    });
    await act(async () => {
      await fireEvent.press(view.getByText('保存配置'));
    });
    expect(mockApiRequest).toHaveBeenCalledWith('/api/v1/users/me/llm-config', expect.objectContaining({
      method: 'PUT',
      body: expect.objectContaining({ provider: 'dashscope', apiKey: 'sk-test', textModel: 'qwen' }),
    }));
    expect(view.getByText('LLM 配置已保存。')).toBeTruthy();
    await act(async () => {
      await fireEvent.press(view.getByText('删除配置'));
    });
    expect(mockApiRequest).toHaveBeenCalledWith('/api/v1/users/me/llm-config', { method: 'DELETE' });
    expect(view.getByText('LLM 配置已删除。')).toBeTruthy();
  });

  it('only offers supported providers and clears vision for DeepSeek', async () => {
    mockUseCloudAuth.mockReturnValue(defaultAuth({ hasPro: true }));
    mockApiRequest.mockResolvedValue({ provider: 'dashscope', textModel: 'qwen', visionModel: 'qwen-vl', configured: true });
    const view = await render(<AISettingsScreen />);
    await waitFor(() => expect(view.getByText('deepseek')).toBeTruthy());
    expect(view.queryByText('openai')).toBeNull();
    expect(view.queryByText('anthropic')).toBeNull();
    await act(async () => {
      await fireEvent.press(view.getByText('deepseek'));
    });
    expect(view.getByText('DeepSeek does not support vision models. / DeepSeek 不支持视觉模型。')).toBeTruthy();
    const inputs = view.container.queryAll((node: any) => node.type === 'TextInput');
    expect(inputs[2].props.value).toBe('');
    await act(async () => {
      await fireEvent.changeText(inputs[0], 'sk-test');
    });
    await act(async () => {
      await fireEvent.press(view.getByText('保存配置'));
    });
    expect(mockApiRequest).toHaveBeenLastCalledWith('/api/v1/users/me/llm-config', expect.objectContaining({
      method: 'PUT',
      body: expect.objectContaining({ provider: 'deepseek', visionModel: null }),
    }));
  });
});

describe('ImportsScreen', () => {
  it('uploads a picked file and navigates to the job', async () => {
    mockUseCloudAuth.mockReturnValue(defaultAuth({ hasPro: true }));
    resources.set('imports', resource());
    resources.set('banks:mine', resource({ data: [bankData(1, { name: '数学' })] }));
    mockUploadImport.mockResolvedValue({ id: 77 });
    documentPicker().mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///tmp/x.pdf', name: 'x.pdf', mimeType: 'application/pdf' }],
    });
    const view = await render(<ImportsScreen />);
    await act(async () => {
      await fireEvent.press(view.getByText('数学'));
    });
    await act(async () => {
      await fireEvent.press(view.getByText('选择文件'));
    });
    expect(mockUploadImport).toHaveBeenCalledWith(
      expect.objectContaining({ bankId: 1, file: expect.objectContaining({ name: 'x.pdf', type: 'application/pdf' }) }),
      'mutation-key',
    );
    expect(router().push).toHaveBeenCalledWith('/imports/77');
    expect(resources.get('imports')!.reload).toHaveBeenCalled();
  });

  it('queues the import offline when the API is queueable', async () => {
    mockUseCloudAuth.mockReturnValue(defaultAuth({ hasPro: true }));
    resources.set('imports', resource());
    resources.set('banks:mine', resource({ data: [bankData(1)] }));
    mockUploadImport.mockRejectedValue(new (ApiError())('rate limited', 'RATE_LIMITED', 429));
    const view = await render(<ImportsScreen />);
    await act(async () => {
      await fireEvent.press(view.getByText('题库1'));
    });
    await act(async () => {
      await fireEvent.press(view.getByText('选择文件'));
    });
    expect(mockEnqueueMutation).toHaveBeenCalledWith('IMPORT', '/api/v1/import-jobs', expect.objectContaining({ bankId: 1 }), 'mutation-key');
    expect(view.getByText('导入文件已离线保存，联网后会自动上传。')).toBeTruthy();
  });

  it('disables the import button without a bank and offers PRO purchase', async () => {
    resources.set('imports', resource());
    resources.set('banks:mine', resource());
    mockUseCloudAuth.mockReturnValue(defaultAuth({ hasPro: true }));
    const view = await render(<ImportsScreen />);
    const buttons = view.container.queryAll((node: any) => node.props.accessibilityRole === 'button');
    expect(buttons.at(-1)?.props.accessibilityState?.disabled).toBe(true); // no bank selected yet
    await act(async () => {
      await fireEvent.press(view.getByText('选择文件'));
    });
    const purchasePro = jest.fn<any, any[]>(async () => undefined);
    mockUseCloudAuth.mockReturnValue(defaultAuth({ hasPro: false, purchasePro }));
    const view2 = await render(<ImportsScreen />);
    await act(async () => {
      await fireEvent.press(view2.getByText('升级 PRO 以使用导入'));
    });
    expect(purchasePro).toHaveBeenCalled();
  });
});

describe('ImportDetailScreen', () => {
  it('renders job details and retries failed jobs', async () => {
    mockUseLocalSearchParams.mockReturnValue({ jobId: '77' });
    resources.set('import:77', resource({
      data: {
        id: 77,
        file_name: 'x.pdf',
        status: 'failed',
        stage: 'extract',
        overall_progress_percent: 50,
        last_error: 'parse error',
        imported_questions: 1,
        total_questions: 10,
      },
    }));
    resources.set('import:77:events', resource({ data: [{ id: 1, status: 'error', message: 'bad row' }] }));
    resources.set('import:77:outputs', resource({ data: [{ id: 1, question_id: 5 }] }));
    mockApiRequest.mockResolvedValue({
      id: 77,
      file_name: 'x.pdf',
      status: 'processing',
      stage: 'extract',
      overall_progress_percent: 50,
      last_error: null,
      imported_questions: 1,
      total_questions: 10,
    });
    const view = await render(<ImportDetailScreen />);
    expect(view.getByText('x.pdf')).toBeTruthy();
    expect(view.getByText('parse error')).toBeTruthy();
    expect(view.getByText('error · bad row')).toBeTruthy();
    await act(async () => {
      await fireEvent.press(view.getByText('重试'));
    });
    expect(mockApiRequest).toHaveBeenCalledWith('/api/v1/import-jobs/77/retry', expect.objectContaining({ method: 'POST' }));
    expect(resources.get('import:77')!.update).toHaveBeenCalled();
    expect(resources.get('import:77:events')!.reload).toHaveBeenCalled();
  });
});

describe('PracticeSetupScreen', () => {
  beforeEach(() => {
    mockUseLocalSearchParams.mockReturnValue({ bankId: '5' });
    resources.set('bank:5', resource({ data: bankData(5, { name: '历史', subject: 'history' }) }));
    resources.set('bank:5:items', resource());
    resources.set('types:history', resource({ data: [{ type_id: 't1', display_name: '简答', default_answer_mode: 'short_answer' }] }));
  });

  it('starts an online session', async () => {
    mockApiRequest.mockResolvedValue({ id: 99 });
    const view = await render(<PracticeSetupScreen />);
    await act(async () => {
      await fireEvent.press(view.getByText('开始'));
    });
    expect(mockApiRequest).toHaveBeenCalledWith('/api/v1/practice-sessions', expect.objectContaining({
      method: 'POST',
      body: expect.objectContaining({ bankId: 5, sessionType: 'practice', mode: 'all', questionCount: 20 }),
    }));
    expect(router().replace).toHaveBeenCalledWith('/practice/99');
  });

  it('falls back to an offline practice when offline with cached questions', async () => {
    mockApiRequest.mockRejectedValue(new (ApiError())('offline', '', 0));
    resources.set('bank:5:items', resource({ data: [itemData(1), itemData(2)] }));
    const view = await render(<PracticeSetupScreen />);
    await act(async () => {
      await fireEvent.press(view.getByText('开始'));
    });
    const key = mockWriteResource.mock.calls[0][0] as string;
    expect(key).toMatch(/^offline-practice:-/);
    expect(mockWriteResource.mock.calls[0][1]).toMatchObject({ bankId: 5, questions: [expect.objectContaining({ question_id: 1 }), expect.objectContaining({ question_id: 2 })] });
    const id = Number(key.slice('offline-practice:'.length));
    expect(router().replace).toHaveBeenCalledWith(`/practice/${id}`);
  });

  it('rejects offline fallback for non-all modes', async () => {
    mockApiRequest.mockRejectedValue(new (ApiError())('offline', '', 0));
    const view = await render(<PracticeSetupScreen />);
    await act(async () => {
      await fireEvent.press(view.getByText('错题重练'));
    });
    await act(async () => {
      await fireEvent.press(view.getByText('开始'));
    });
    expect(view.getByText('此练习模式需要联网。')).toBeTruthy();
  });
});

describe('PracticeSessionScreen', () => {
  it('works through an offline practice and queues the result', async () => {
    mockUseLocalSearchParams.mockReturnValue({ sessionId: '-42' });
    mockReadResource.mockResolvedValue({
      id: -42,
      bankId: 5,
      index: 0,
      startedAt: '2026-08-01T00:00:00.000Z',
      answers: [],
      questions: [itemData(1), itemData(2)],
    });
    const view = await render(<PracticeSessionScreen />);
    await waitFor(() => expect(view.getByText('离线练习')).toBeTruthy());
    expect(view.getByText('1/2')).toBeTruthy();
    await act(async () => {
      await fireEvent.changeText(view.container.queryAll((node: any) => node.type === 'TextInput')[0], '我的答案');
    });
    await act(async () => {
      await fireEvent.press(view.getByText('提交并继续'));
    });
    expect(view.getByText('2/2')).toBeTruthy();
    await act(async () => {
      await fireEvent.changeText(view.container.queryAll((node: any) => node.type === 'TextInput')[0], '第二题');
    });
    await act(async () => {
      await fireEvent.press(view.getByText('完成'));
    });
    expect(mockEnqueueMutation).toHaveBeenCalledWith(
      'POST',
      '/api/v1/offline-practice',
      {
        bankId: 5,
        answers: [
          { questionId: 1, answerPayload: { value: '我的答案' } },
          { questionId: 2, answerPayload: { value: '第二题' } },
        ],
      },
      'offline-practice-42',
    );
    expect(view.getByText('离线练习已完成并加入同步队列。')).toBeTruthy();
    expect(view.getByText('等待同步')).toBeTruthy();
  });

  it('submits answers, navigates pages and finishes with results', async () => {
    mockUseLocalSearchParams.mockReturnValue({ sessionId: '42' });
    const pageData = {
      question: itemData(1, {
        answer_mode: 'choice',
        choice_variant: 'single',
        options: [
          { id: 1, option_label: 'A', content: '甲' },
          { id: 2, option_label: 'B', content: '乙' },
        ],
      }),
      questionIndex: 0,
      total: 2,
      progress: [
        { questionId: 1, index: 0, isAnswered: false },
        { questionId: 2, index: 1, isAnswered: false },
      ],
      previousIndex: null,
      nextIndex: 1,
      result: null,
      session: { status: 'active' },
    };
    const pageResource = resource({ data: pageData });
    resources.set('practice:42:page:0', pageResource);
    mockMutateOrQueue.mockResolvedValue({ queued: false, data: { is_correct: true } });
    const view = await render(<PracticeSessionScreen />);
    await waitFor(() => expect(view.getByText('题干1')).toBeTruthy());
    await act(async () => {
      await fireEvent.press(view.getByText('A. 甲'));
    });
    await act(async () => {
      await fireEvent.press(view.getByText('提交'));
    });
    expect(mockMutateOrQueue).toHaveBeenCalledWith(
      '/api/v1/practice-sessions/42/answers',
      'POST',
      { questionId: 1, answerPayload: { selected: ['A'] } },
      expect.anything(),
    );
    expect(view.getByText('回答正确。')).toBeTruthy();
    expect(pageResource.reload).toHaveBeenCalled();
    await act(async () => {
      await fireEvent.press(view.getByText('下一题'));
    });
    expect(mockUseCachedResource).toHaveBeenCalledWith('practice:42:page:1', expect.stringContaining('index=1'), expect.anything(), expect.anything(), expect.anything());
  });

  it('shows results after finishing and abandons practice', async () => {
    mockUseLocalSearchParams.mockReturnValue({ sessionId: '42' });
    resources.set('practice:42:page:0', resource({
      data: {
        question: itemData(1),
        questionIndex: 0,
        total: 1,
        progress: [{ questionId: 1, index: 0, isAnswered: true }],
        previousIndex: null,
        nextIndex: null,
        result: { is_correct: true },
        session: { status: 'active' },
      },
    }));
    mockMutateOrQueue.mockResolvedValue({ queued: false, data: {} });
    mockApiRequest.mockResolvedValue([{ id: 1, stem: '题干1', is_correct: true, analysis: '解析' }]);
    const view = await render(<PracticeSessionScreen />);
    await waitFor(() => expect(view.getByText('完成')).toBeTruthy());
    await act(async () => {
      await fireEvent.press(view.getByText('完成'));
    });
    expect(mockMutateOrQueue).toHaveBeenCalledWith('/api/v1/practice-sessions/42/complete', 'POST', undefined, expect.anything());
    await waitFor(() => expect(view.getByText('练习结果')).toBeTruthy());
    expect(view.getByText('解析')).toBeTruthy();
    await act(async () => {
      await fireEvent.press(view.getByText('返回概览'));
    });
    expect(router().replace).toHaveBeenCalledWith('/');
    // abandoning navigates home as well
    const view2 = await render(<PracticeSessionScreen />);
    await waitFor(() => expect(view2.getByText('放弃练习')).toBeTruthy());
    await act(async () => {
      await fireEvent.press(view2.getByText('放弃练习'));
    });
    expect(mockMutateOrQueue).toHaveBeenCalledWith('/api/v1/practice-sessions/42/abandon', 'POST', undefined, expect.anything());
    expect(router().replace).toHaveBeenCalledWith('/');
  });
});
