import { useNavigation } from 'expo-router';
import { useCallback, useEffect, useRef } from 'react';
import { Alert } from 'react-native';

import { useLanguage } from './language';

export function useUnsavedChanges(hasUnsavedChanges: boolean) {
  const navigation = useNavigation();
  const { tr } = useLanguage();
  const allowRemove = useRef(false);
  const promptOpen = useRef(false);

  const runWithoutPrompt = useCallback((action: () => void) => {
    allowRemove.current = true;
    try {
      action();
    } finally {
      requestAnimationFrame(() => { allowRemove.current = false; });
    }
  }, []);

  const confirmDiscard = useCallback((action: () => void) => {
    if (!hasUnsavedChanges) return action();
    if (promptOpen.current) return;
    promptOpen.current = true;
    Alert.alert(
      tr('Discard unsaved changes?', '放弃未保存更改？'),
      tr('Your changes have not been saved.', '你的更改尚未保存。'),
      [
        {
          text: tr('Keep editing', '继续编辑'),
          style: 'cancel',
          onPress: () => { promptOpen.current = false; },
        },
        {
          text: tr('Discard', '放弃'),
          style: 'destructive',
          onPress: () => {
            promptOpen.current = false;
            runWithoutPrompt(action);
          },
        },
      ],
      {
        cancelable: true,
        onDismiss: () => { promptOpen.current = false; },
      },
    );
  }, [hasUnsavedChanges, runWithoutPrompt, tr]);

  useEffect(() => navigation.addListener('beforeRemove', (event) => {
    if (!hasUnsavedChanges || allowRemove.current) return;
    event.preventDefault();
    confirmDiscard(() => navigation.dispatch(event.data.action));
  }), [confirmDiscard, hasUnsavedChanges, navigation]);

  return { confirmDiscard, runWithoutPrompt };
}
