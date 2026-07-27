import { render } from '@testing-library/react-native';
import { HeroUINativeProvider } from 'heroui-native/provider';

import { ContentBlockView } from './components/question-content';

jest.mock('@/language', () => ({
  useLanguage: () => ({
    tr: (english: string) => english,
  }),
}));

jest.mock('expo-video', () => ({
  VideoView: () => null,
  useVideoPlayer: jest.fn(),
}));

describe('ContentBlockView', () => {
  it('renders delimited table content as accessible cells', async () => {
    const screen = await render(
      <HeroUINativeProvider config={{ devInfo: { stylingPrinciples: false } }}>
        <ContentBlockView
          block={{
            kind: 'table',
            content: 'Name,Score\nAda,98\nLin,95',
            sort_order: 0,
          }}
        />
      </HeroUINativeProvider>,
    );

    screen.getByText('Name');
    screen.getByText('Score');
    screen.getByText('Ada');
    screen.getByText('98');
  });
});
