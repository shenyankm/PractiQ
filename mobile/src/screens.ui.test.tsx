// Render tests for screens.tsx. heroui-native ships ESM modules that fail to
// load under --experimental-vm-modules, so every heroui subpath is stubbed
// with a lightweight component; this also keeps each render fast. Native
// modules (expo-router, document picker, file system) and the data layer
// (use-resource, auth, api, cache) are mocked to script interactions.
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
  AnalyticsScreen,
  BankDetailScreen,
  BanksScreen,
  NewBankScreen,
  OverviewScreen,
  QuestionScreen,
  SearchScreen,
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

const router = () => jest.requireMock('expo-router').router;

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
  mockUploadImport.mockReset();
  mockCreateMutationKey.mockReturnValue('mutation-key');
  mockEnqueueMutation.mockReset();
  mockReadResource.mockReset();
  mockWriteResource.mockReset();
  router().push.mockClear();
  router().replace.mockClear();
});

describe('OverviewScreen', () => {
  it('renders stats, recent banks/sessions and reloads everything together', async () => {
    const summary = resource({ data: { owned_banks: 3, sessions: 7, attempts: 12, correct: 9, wrong: 3, favorite_banks: 1, active_sessions: 0, active_imports: 0, accuracy: 75 } });
    const banks = resource({ data: [bankData(1, { name: '数学', subject: 'math', total_count: 20 })] });
    const sessions = resource({ data: [{ id: 9, question_count: 10, answered_count: 5, status: 'active' }] });
    resources.set('analytics:summary', summary);
    resources.set('banks:mine', banks);
    resources.set('practice:recent', sessions);
    const view = await render(<OverviewScreen />);
    expect(view.getByText('学习概览')).toBeTruthy();
    expect(view.getByText('3')).toBeTruthy();
    expect(view.getByText('数学')).toBeTruthy();
    expect(view.getByText('#9')).toBeTruthy();
    await act(async () => {
      await fireEvent.press(view.getByText('打开'));
    });
    expect(router().push).toHaveBeenCalledWith('/banks/1');
    await act(async () => {
      await fireEvent(view.container.queryAll((node: any) => node.type === 'RCTRefreshControl')[0], 'refresh');
    });
    expect(summary.reload).toHaveBeenCalled();
    expect(banks.reload).toHaveBeenCalled();
    expect(sessions.reload).toHaveBeenCalled();
  });

  it('shows the error alert and empty-state hint', async () => {
    resources.set('analytics:summary', resource({ error: '网络错误', loading: false }));
    resources.set('banks:mine', resource({ data: [], loading: false }));
    const view = await render(<OverviewScreen />);
    expect(view.getByText('网络错误')).toBeTruthy();
    expect(view.getByText('还没有题库。')).toBeTruthy();
  });
});

describe('BanksScreen', () => {
  it('switches scope, shows favorite/pending chips and loads more', async () => {
    const favoritesResource = resource({ data: [], hasMore: true, loadingMore: false });
    resources.set('banks:mine', resource({ data: [bankData(1, { is_favorite: true, pending: true, description: '题库说明' })] }));
    resources.set('banks:favorites', favoritesResource);
    const view = await render(<BanksScreen />);
    expect(view.getByText(/题库说明/)).toBeTruthy();
    expect(view.getByText('已收藏')).toBeTruthy();
    expect(view.getByText('待同步')).toBeTruthy();
    await act(async () => {
      await fireEvent.press(view.getByText('收藏'));
    });
    expect(mockUseCachedResource).toHaveBeenLastCalledWith('banks:favorites', expect.stringContaining('scope=favorites'), expect.anything(), expect.anything(), expect.anything(), undefined);
    await act(async () => {
      await fireEvent.press(view.getByText('加载更多'));
    });
    expect(favoritesResource.loadMore).toHaveBeenCalled();
    await act(async () => {
      await fireEvent.press(view.getByText('新建题库'));
    });
    expect(router().push).toHaveBeenCalledWith('/banks/new');
  });

  it('routes the import button by pro status', async () => {
    const view = await render(<BanksScreen />);
    await act(async () => {
      await fireEvent.press(view.getByText('PRO 导入'));
    });
    expect(router().push).toHaveBeenCalledWith('/settings');
    mockUseCloudAuth.mockReturnValue(defaultAuth({ hasPro: true, user: { id: 2, username: 'u', email: 'e' } }));
    const proView = await render(<BanksScreen />);
    await act(async () => {
      await fireEvent.press(proView.getByText('导入'));
    });
    expect(router().push).toHaveBeenCalledWith('/imports');
  });

  it('shows the empty hint and opens a bank', async () => {
    resources.set('banks:mine', resource({ data: [bankData(1)] }));
    const view = await render(<BanksScreen />);
    expect(view.queryByText('没有匹配的题库。')).toBeNull();
    await act(async () => {
      await fireEvent.press(view.getByText('打开'));
    });
    expect(router().push).toHaveBeenCalledWith('/banks/1');
  });
});

describe('NewBankScreen', () => {
  it('saves a new bank online and navigates to it', async () => {
    resources.set('banks:mine', resource());
    resources.set('subjects', resource({ data: [{ subject_id: 'math', display_name: '数学' }] }));
    mockMutateOrQueue.mockResolvedValue({ data: { id: 42 }, queued: false });
    const view = await render(<NewBankScreen />);
    await act(async () => {
      await fireEvent.press(view.getByText('数学'));
    });
    await act(async () => {
      await fireEvent.changeText(view.container.queryAll((node: any) => node.type === 'TextInput')[0], '我的题库');
    });
    await act(async () => {
      await fireEvent.press(view.getByText('保存'));
    });
    expect(mockMutateOrQueue).toHaveBeenCalledWith('/api/v1/banks', 'POST', {
      name: '我的题库',
      description: '',
      subject: 'math',
      isPublic: false,
    });
    expect(resources.get('banks:mine')!.update).toHaveBeenCalledWith([expect.objectContaining({ id: 42 }), ...[]]);
    expect(router().replace).toHaveBeenCalledWith('/banks/42');
  });

  it('queues an offline bank with an optimistic row', async () => {
    resources.set('banks:mine', resource());
    resources.set('subjects', resource());
    mockMutateOrQueue.mockResolvedValue({ queued: true, data: null });
    const view = await render(<NewBankScreen />);
    await act(async () => {
      await fireEvent.changeText(view.container.queryAll((node: any) => node.type === 'TextInput')[0], '离线题库');
    });
    await act(async () => {
      await fireEvent.press(view.getByText('保存'));
    });
    expect(router().replace).not.toHaveBeenCalled();
    expect(view.getByText('已离线保存，联网后会自动上传。')).toBeTruthy();
    const update = resources.get('banks:mine')!.update as jest.Mock;
    const optimistic = update.mock.calls[0][0][0];
    expect(optimistic).toMatchObject({ pending: true, is_owner: true, subject: 'general' });
    expect(optimistic.id).toBeLessThan(0);
  });

  it('surfaces save errors', async () => {
    resources.set('banks:mine', resource());
    resources.set('subjects', resource());
    mockMutateOrQueue.mockRejectedValue(new Error('boom'));
    const view = await render(<NewBankScreen />);
    await act(async () => {
      await fireEvent.changeText(view.container.queryAll((node: any) => node.type === 'TextInput')[0], '题库');
    });
    await act(async () => {
      await fireEvent.press(view.getByText('保存'));
    });
    expect(view.getByText('boom')).toBeTruthy();
  });
});

describe('BankDetailScreen', () => {
  beforeEach(() => {
    mockUseLocalSearchParams.mockReturnValue({ bankId: '5' });
  });

  it('renders bank, items and toggles favorite', async () => {
    resources.set('bank:5', resource({ data: bankData(5, { name: '历史', description: '描述', subject: 'history' }) }));
    resources.set('bank:5:items', resource({ data: [itemData(1), itemData(2)] }));
    const view = await render(<BankDetailScreen />);
    expect(view.getByText('历史')).toBeTruthy();
    expect(view.getByText('1 · active')).toBeTruthy();
    await act(async () => {
      await fireEvent.press(view.getByText('收藏'));
    });
    expect(mockMutateOrQueue).toHaveBeenCalledWith('/api/v1/banks/5/favorite', 'POST');
    expect(resources.get('bank:5')!.update).toHaveBeenCalledWith(expect.objectContaining({ is_favorite: true }));
    await act(async () => {
      await fireEvent.press(view.getByText('管理'));
    });
    expect(router().push).toHaveBeenCalledWith('/banks/5/manage');
  });

  it('shows queued-favorite message and hides manage for non-owners', async () => {
    resources.set('bank:5', resource({ data: bankData(5, { is_owner: false, is_favorite: true }) }));
    resources.set('bank:5:items', resource());
    mockMutateOrQueue.mockResolvedValue({ queued: true, data: null });
    const view = await render(<BankDetailScreen />);
    expect(view.queryByText('管理')).toBeNull();
    await act(async () => {
      await fireEvent.press(view.getByText('取消收藏'));
    });
    expect(view.getByText('收藏变更已加入同步队列。')).toBeTruthy();
  });
});

describe('QuestionScreen', () => {
  const baseQuestion = {
    question_type_id: 't1',
    answer_mode: 'short_answer',
    status: 'draft',
    can_edit: true,
    stem: '',
    analysis: '',
    options: [],
    media_links: [],
  };

  beforeEach(() => {
    mockUseLocalSearchParams.mockReturnValue({ questionId: '7' });
    mockUseCloudAuth.mockReturnValue(defaultAuth({ hasPro: true, session: { token: 'tok', username: 'u' } }));
  });

  it('renders a read-only question with options and media', async () => {
    resources.set('question:7', resource({
      data: {
        ...baseQuestion,
        status: 'active',
        can_edit: false,
        stem: '题干',
        options: [{ id: 1, option_label: 'A', content: '甲' }],
        media_links: [{ id: 1, media_id: 2 }],
      },
    }));
    const view = await render(<QuestionScreen />);
    expect(view.getByText('题干')).toBeTruthy();
    expect(view.getByText('A. 甲')).toBeTruthy();
    expect(view.queryByText('保存')).toBeNull();
    expect(view.getByLabelText('题目附件')).toBeTruthy();
  });

  it('saves edits and publishes a draft', async () => {
    resources.set('question:7', resource({ data: { ...baseQuestion, stem: '旧题干' } }));
    mockMutateOrQueue.mockResolvedValue({ queued: false, data: null });
    const view = await render(<QuestionScreen />);
    const inputs = view.container.queryAll((node: any) => node.type === 'TextInput');
    await act(async () => {
      await fireEvent.changeText(inputs[0], '新题干');
    });
    await act(async () => {
      await fireEvent.press(view.getByText('保存'));
    });
    expect(mockMutateOrQueue).toHaveBeenCalledWith('/api/v1/questions/7', 'PATCH', { stem: '新题干', analysis: '' });
    expect(view.getByText('已保存。')).toBeTruthy();
    await act(async () => {
      await fireEvent.press(view.getByText('发布'));
    });
    expect(mockMutateOrQueue).toHaveBeenCalledWith('/api/v1/questions/7/publish', 'POST');
    expect(view.getByText('已更新。')).toBeTruthy();
    expect(resources.get('question:7')!.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'active' }));
  });

  it('routes to AI settings when the LLM config is missing', async () => {
    resources.set('question:7', resource({ data: { ...baseQuestion, stem: '题干' } }));
    const ApiError = jest.requireMock('./practiq/api').ApiError;
    mockApiRequest.mockRejectedValue(new ApiError('no llm', 'LLM_CONFIG_REQUIRED', 400));
    const view = await render(<QuestionScreen />);
    await act(async () => {
      await fireEvent.press(view.getByText('AI 生成答案'));
    });
    expect(router().push).toHaveBeenCalledWith('/settings/ai');
    expect(view.getByText('no llm')).toBeTruthy();
  });

  it('offers a purchase when generating without pro', async () => {
    resources.set('question:7', resource({ data: { ...baseQuestion, stem: '题干' } }));
    const purchasePro = jest.fn<any, any[]>(async () => undefined);
    mockUseCloudAuth.mockReturnValue(defaultAuth({ hasPro: false, purchasePro }));
    const view = await render(<QuestionScreen />);
    await act(async () => {
      await fireEvent.press(view.getByText('AI 生成答案'));
    });
    expect(purchasePro).toHaveBeenCalled();
  });
});

describe('AnalyticsScreen', () => {
  it('renders the snapshot and reviews weak questions', async () => {
    resources.set('analytics:snapshot', resource({
      data: {
        summary: { attempts: 10, correct: 6, wrong: 4, accuracy: 60, owned_banks: 1, favorite_banks: 1, sessions: 2, active_sessions: 0, active_imports: 0 },
        recentSessions: [],
        weakQuestions: [{ question_id: 3, stem: '弱题', wrong_count: 2 }],
      },
    }));
    const view = await render(<AnalyticsScreen />);
    expect(view.getByText('10')).toBeTruthy();
    expect(view.getByText('弱题')).toBeTruthy();
    expect(view.getByText('错误 2 次')).toBeTruthy();
    await act(async () => {
      await fireEvent.press(view.getByText('查看'));
    });
    expect(router().push).toHaveBeenCalledWith('/questions/3');
  });
});

describe('SearchScreen', () => {
  it('searches, renders results and opens one', async () => {
    resources.set('search:questions:abc', resource({ data: [{ id: 9, stem: '找到的题' }] }));
    const view = await render(<SearchScreen />);
    await act(async () => {
      await fireEvent.changeText(view.container.queryAll((node: any) => node.type === 'TextInput')[0], 'abc');
    });
    await act(async () => {
      await fireEvent.press(view.getAllByText('搜索').at(-1)!);
    });
    await waitFor(() => expect(view.getByText('找到的题')).toBeTruthy());
    await act(async () => {
      await fireEvent.press(view.getByText('打开'));
    });
    expect(router().push).toHaveBeenCalledWith('/questions/9');
  });
});
