# Practise, review scores, and keep drafts

Use the offline practice app on macOS. Start with the [no-model walkthrough](../../README.md#try-it-without-a-model); import and share files through the [question-bank ZIP guide](question-bank-package.md). This guide explains practice behavior and optional AI grading.

## Choose questions and start a session

If question statistics or the manual question list fails to load in study setup, use its retry button to read the same query again. Retrying preserves selected banks and questions, per-type quotas, a question count you entered, and exam settings. If you have not changed the count, the first successful statistics read initializes a feasible default, including after a retry. The button is disabled while that read is pending.

Self-tests and mock exams have separate setup and score-review steps. Quick question counts sit beside the count field. The review shows allocated points against the target total; tap a question score to edit it. **Back to setup** and **View scores** preserve edited scores unless question selection or the target total changes. Generating a new preview explicitly replaces the selection and scores.

Practice submits individual answers. Self-tests and mock exams submit the entire paper; answers and explanations become available after submission. Timed exams keep their deadline when the app closes or the device sleeps. Reopening an expired exam submits the last saved answers; closing the app does not extend its time limit.

Selection preserves complete material groups. With Wrong or Unattempted filtering, search also matches shared material on ancestors of eligible children, without matching unrelated siblings. Question counts count answerable children; parents hold material and receive no score. Source edits and deletions do not rewrite saved session snapshots. See the [session behavior reference](../reference/question-types-data-rendering.md#6-practice-self-test-and-mock-exams) for timing, scoring and reveal rules.

Finished-session navigation uses the full attempt count even when cached responses contain only changed attempts. Browsing history changes the displayed question without modifying the saved practice position.

Finished sessions open as **Practice review**, with readable **My answer** content instead of disabled answer inputs. Empty responses are labelled explicitly. History shows the graded-question denominator next to accuracy and lists skipped and ungraded questions separately. The answer card includes a visible legend for states present in the session.

During practice and review, **View passage** expands material within the question. Moving between children of the same material group preserves its expansion and reading position for the current app run. General group instructions can be expanded from their title. On narrow screens, question content scrolls above a separate Previous/Next bar.

## Submit answers and review scores

In practice, submit an answer before choosing **I got it right** or **I got it wrong**. Self-assessment remains available after finishing for submitted, unskipped answers that need it, including fill-in-the-blank overrides. It uses a separate action and preserves the submitted answer, automatic result and practice snapshot. Self-tests and mock exams use their score-review workflow.

Submitting or skipping a practice question locks its answer and clear action until persistence finishes. Success displays the answer returned by local storage; failure restores editing with the current answer and save error. Background draft saving waits for an outstanding submission and cannot overwrite a submitted answer.

Moving between questions locks answer editing, submission and the Previous/Next bar until the current draft is saved and the destination is loaded. Repeated navigation requests are ignored while that move is pending. If saving fails, the original question and draft remain visible with **Retry save**; a failed destination read also restores editing on the current question.

Missing reference answers, required resources or grading evidence remain ungraded. Required image/audio files are read and checked against their stored size and SHA-256 when loading bank questions and again before submission, including resources inherited from a material group. A missing or damaged file leaves new submissions ungraded; existing score snapshots are not rewritten.

Incomplete choice, ordering and matching structures use free-text answers and practice self-assessment. These answers survive draft saving, restarting and submission even for older frozen questions whose review flags do not describe the structural problem. Structured questions with ambiguous item identities are never automatically graded. Matching IDs are independent on each side; ordering IDs must be unique across the item list. Missing IDs use the item's zero-based position within its side or ordering list, so explicit IDs must not collide with those positions. The app retains ambiguous IDs and reference answers for review rather than guessing a corrected mapping.

Imported review warnings permit practice; confirming review records a local acknowledgement for the whole question tree without clearing source warnings or proving answer correctness. Changing the tree's content or child-question order clears that acknowledgement; saving an unchanged tree preserves it, including after restarting the app or importing a package that listed children before their parent. Filling a composite's missing passage clears its derived material-missing marker for future practice; imported review warnings and existing practice snapshots remain unchanged.

## Use optional AI grading

Practice and local scoring work offline. For optional subjective AI grading, choose **Direct model API** in **Settings → AI service** and enter an OpenAI-compatible API base URL, model ID and your own API key (or select **Independent AI service** for existing service URL/token deployments), then explicitly start grading or retry. Grading requires a reference answer or rubric; missing evidence, failed calls and unknown outcomes remain ungraded. It is intended for personal practice, not formal examination scoring. Opening the app or changing settings does not call a model. Missing service configuration offers **Configure AI service** and **Return to grading**, preserving the current session and question without automatically retrying. Manual score and reason drafts survive question changes and returning through history during the current app run; they are not persisted or included in backups until **Save manual score** succeeds. Failed saves keep the draft.

Service settings show saving and saved feedback separately from connection-test status. A configured URL and token remain untested until **Test connection** is explicitly pressed; changing either clears the previous verdict. Direct checks only read `/models`; service checks read the existing health endpoint. Neither grades answers. Direct endpoints must support Chat Completions JSON mode and `max_tokens`; image questions require a vision model.

The app stores model API keys and service tokens in the platform credential store. Direct model keys are held in the same native credential store under a separate account namespace and never reused from legacy settings. Document-import keys stay in the independent service. Direct calls send the frozen question, related materials, images and answer to the configured provider. Each explicit action makes at most one request (120-second timeout, 4,096 output tokens); refused, invalid or truncated JSON never replaces a saved score. An unknown request is never automatically replayed: checking returns its local receipt, while explicit regrading creates a new potentially paid request. Endpoint/model changes also require explicit regrading. In independent-service mode, checking an unknown result may contact only the same service URL recorded when grading started. Changing that URL, switching grading modes, or checking an older receipt without a recorded target requires explicit regrading with a new request ID; the old outcome is retained. Rotating the token alone does not change the target. Connection settings and saved grading results have different backup rules; see [data and credential boundaries](../reference/question-model.md#versions-and-directories). Parsing extracts supplied answers and rubrics without solving unanswered questions.

## Keep editor drafts

When a bank or question draft has changed, Escape, the close button and clicking outside offer **Continue editing** or **Discard changes**. Unchanged or reverted drafts close immediately. Continuing preserves the draft; discarding closes without saving. Child-question edits stay staged in the parent until you save the top-level question.

Listening URLs require an explicit fetch. An entered or selected URL that has not been applied is protected as an unsaved change; fetch it or clear it before saving. Saving never starts a download. Changing the audio or answer mode can make a retained URL unapplied again. URL fetching has a 45-second total deadline covering DNS lookups, redirects and response reads. A system DNS lookup cannot be cancelled; if it remains blocked after timeout, further hostname lookups fail without starting extra workers until it finishes. Retry explicitly after checking the network or VPN configuration.

Editor drafts stay in memory while open and are not recovered after closing the app. Closing or quitting the macOS app asks before discarding unsaved editor changes or manual grading drafts. Saved practice drafts and successfully saved manual scores remain durable.



## Retry failed reads

If the listening player cannot read its saved playback state, use **Retry** in the player. This only rereads local playback state: it does not play audio, consume a play, or start AI grading. In self-tests and mock exams, playback stays unavailable until state is loaded, and exhausted play limits still apply. Moving between questions in the same listening group does not automatically retry the failed read. After recovery, press **Play audio** explicitly to listen.

Question lists have visible search and question-type labels. Bank totals count answerable subquestions; matching list items count whole material groups once. Favorites remain directly accessible on each row, while Edit and Delete are under the question actions menu. Saving a favorite updates the star in place without clearing the list; selected stars are yellow and a top-center notification confirms adding or removing a favorite. The question-type filter sizes to its content instead of reserving a fixed-width column. An empty Favorites list offers Browse banks and explains the star action; filter-empty results retain the filter-clearing guidance. When filters are active, **清除筛选** resets search, type, and pagination within the current bank or list, then returns focus to search. An empty filtered list is identified as no matches rather than no mistakes or favorites.

Question lists hide previous results while loading. A failed read stays visible with a Retry action that preserves the current bank, search, type and page. A failed overview read has its own retry action and is never displayed as zero banks. If import, merge or save succeeds but the overview cannot refresh, the completed action is retained and retry only reloads data; do not repeat the write. Import completion clears search and type filters in the destination bank.

## Set language and motion preferences

The first supported system language is used until you choose a language in the sidebar. That choice is saved locally and included in full backups; a failed save can be retried. Dates and numbers use the matching regional system preference. Language changes preserve question content and answers; materials with known language metadata declare their own language for assistive tools. AI grading captures the selected feedback language when you start it, and resuming the same request preserves that language.

Shared dialogs, confirmation dialogs and menus respect the system reduced-motion preference by disabling their entry and exit animations. Keyboard focus entry, dismissal and restoration use the same behavior for both motion preferences.

## Workspace controls

Create an empty bank with **新建题库** and append content through **Settings → Import and restore → Import bank ZIP**. Start practice from the bank card. The bank question page is for browsing: its header has no import, add-question or start-practice buttons, and its filters cover search and question type, not pending review. Review imported content during import; saved quality warnings remain visible. Each question row places the type label before its content on the same line. Session setup explains practice, untimed self-test and timed exam behavior and offers only feasible quick counts. **查看答题卡** and **返回当前题** move between question content and navigation while preserving drafts. The answer-card progress bar counts submitted questions in practice and drafts with content in exams.

Question editors and ZIP import dialogs keep their actions outside the scrolling content. Score review follows question/reference context, separates confirmed scores from pending results, and keeps visible labels on manual score/reason inputs. Connection-test feedback remains in the form until another test or an address/token edit. See [Workspace UX decisions](../product/ux-workspace.md) for the complete review and verification scope.
