# Practise, review scores, and keep drafts

Use the offline practice app on macOS, Windows or Android. Start with the [no-model walkthrough](../README.md#try-it-without-a-model); import and share files through the [question-bank ZIP guide](question-bank-package.md). This guide explains practice behavior and optional service grading.

## Choose questions and start a session

If question statistics or the manual question list fails to load in study setup, use its retry button to read the same query again. Retrying preserves selected banks and questions, per-type quotas, a question count you entered, and exam settings. If you have not changed the count, the first successful statistics read initializes a feasible default, including after a retry. The button is disabled while that read is pending.

Practice submits individual answers. Self-tests and mock exams submit the entire paper; answers and explanations become available after submission. Timed exams keep their deadline when the app closes or the device sleeps. Reopening an expired exam submits the last saved answers; closing the app does not extend its time limit.

Selection preserves complete material groups. Question counts count answerable children; parents hold material and receive no score. Source edits and deletions do not rewrite saved session snapshots. See the [session behavior reference](question-types-data-rendering.md#6-practice-self-test-and-mock-exams) for timing, scoring and reveal rules.

## Submit answers and review scores

In practice, submit an answer before choosing **I got it right** or **I got it wrong**. Self-assessment remains available after finishing for submitted, unskipped answers that need it, including fill-in-the-blank overrides. It uses a separate action and preserves the submitted answer, automatic result and practice snapshot. Self-tests and mock exams use their score-review workflow.

Missing reference answers, required resources or grading evidence remain ungraded. Imported review warnings permit practice; confirming review records a local acknowledgement for the whole question tree without clearing source warnings or proving answer correctness. Editing the tree clears that acknowledgement.

## Use optional AI grading

Practice and local scoring work offline. For optional subjective AI grading, configure the independent service URL and access token in desktop **Settings → AI service**, then explicitly start grading or retry. Grading requires a reference answer or rubric; missing evidence, failed calls and unknown outcomes remain ungraded. It is intended for personal practice, not formal examination scoring. Opening the app or changing settings does not call a model. Missing service configuration offers **Configure AI service** and **Return to grading**, preserving the current session and question without automatically retrying. Manual score and reason drafts survive question changes and returning through history during the current app run; they are not persisted or included in backups until **Save manual score** succeeds. Failed saves keep the draft.

The app stores service tokens in the platform credential store. Provider configuration and keys stay in the independent service. Service URLs and saved grading results have different backup rules; see [data and credential boundaries](question-model.md#versions-and-directories). Parsing extracts supplied answers and rubrics without solving unanswered questions.

## Keep editor drafts

When a bank or question draft has changed, Escape, the close button and clicking outside offer **Continue editing** or **Discard changes**. Unchanged or reverted drafts close immediately. Continuing preserves the draft; discarding closes without saving. Child-question edits stay staged in the parent until you save the top-level question.

Listening URLs require an explicit fetch. An entered or selected URL that has not been applied is protected as an unsaved change; fetch it or clear it before saving. Saving never starts a download. Changing the audio or answer mode can make a retained URL unapplied again.

Editor drafts stay in memory while open and are not recovered after closing the app. Closing or quitting the macOS/Windows app asks before discarding unsaved editor changes or manual grading drafts. Saved practice drafts and successfully saved manual scores remain durable.


On Android, system Back closes dialogs or the navigation drawer first and respects unsaved-change confirmation. Leaving a practice route saves its draft; failed saves keep the session visible. See the [Android guide](../app/docs/android.md#files-backups-and-credentials) for native file and lifecycle behavior.

## Retry failed reads

Question lists have visible search and question-type labels. When filters are active, **清除筛选** resets search, type, review-only selection and pagination within the current bank or list, then returns focus to search. An empty filtered list is identified as no matches rather than no mistakes or favorites.

Question lists hide previous results while loading. A failed read stays visible with a Retry action that preserves the current bank, search, type, review filter and page. A failed overview read has its own retry action and is never displayed as zero banks. If import, merge or save succeeds but the overview cannot refresh, the completed action is retained and retry only reloads data; do not repeat the write. Import completion clears search, type and review filters in the destination bank.

## Set language and motion preferences

The first supported system language is used until you choose a language in the sidebar. That choice is saved locally and included in full backups; a failed save can be retried. Dates and numbers use the matching regional system preference. Language changes preserve question content and answers; materials with known language metadata declare their own language for assistive tools. AI grading captures the selected feedback language when you start it, and resuming the same request preserves that language.

Shared dialogs, confirmation dialogs and menus respect the system reduced-motion preference by disabling their entry and exit animations. Keyboard focus entry, dismissal and restoration use the same behavior for both motion preferences.

## Workspace controls

Create an empty bank with **新建题库**, then open it to add questions. Session setup explains practice, untimed self-test and timed exam behavior and offers only feasible quick counts. **查看答题卡** and **返回当前题** move between question content and navigation while preserving drafts. The answer-card progress bar counts submitted questions in practice and drafts with content in exams.

Question editors and ZIP import dialogs keep their actions outside the scrolling content. Score review follows question/reference context, separates confirmed scores from pending results, and keeps visible labels on manual score/reason inputs. Connection-test feedback remains in the form until another test or an address/token edit. See [Workspace UX decisions](ux-workspace.md) for the complete review and verification scope.
