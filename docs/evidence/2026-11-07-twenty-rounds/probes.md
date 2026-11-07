# document_parser 评测

状态：**PASSED**

## 质量指标

| 指标 | 数值 |
|---|---:|

## 离线故障探针

| 指标 | 数值 |
|---|---:|
| recoverySuccessRate | 100.00 |
| correctStopRate | 100.00 |
| routingPassRate | 100.00 |
| unknownUsagePassRate | 100.00 |

| 探针 | 状态 |
|---|---|
| test_broker_operations.test_publisher_failure_does_not_close_consumer_or_lose_its_ack | PASSED |
| test_broker_operations.test_memory_alarm_keeps_consumer_ack_and_outbox_recovers | PASSED |
| test_broker_operations.test_capacity_policy_rejects_publish_and_full_dlq_retains_dead_letters | PASSED |
| test_broker_operations.test_three_node_quorum_survives_connected_leader_loss_without_repeating_models | PASSED |
| test_messaging.test_ambiguous_broker_windows_do_not_repeat_models[before_publish] | PASSED |
| test_messaging.test_ambiguous_broker_windows_do_not_repeat_models[after_publish] | PASSED |
| test_messaging.test_ambiguous_broker_windows_do_not_repeat_models[confirm_unknown] | PASSED |
| test_messaging.test_ambiguous_broker_windows_do_not_repeat_models[ack_unknown] | PASSED |
| test_messaging.test_broker_failure_keeps_old_execution_exclusive_and_outbox_durable[disconnect] | PASSED |
| test_messaging.test_broker_failure_keeps_old_execution_exclusive_and_outbox_durable[restart] | PASSED |
| test_messaging.test_consumer_timeout_does_not_overlap_or_repeat_old_execution | PASSED |
| test_messaging.test_cancelled_delivery_handler_cannot_release_execution_capacity | PASSED |
| test_messaging.test_execution_cancelled_before_first_step_is_redelivered_without_stale_active_entry | PASSED |
| test_runtime_recovery.test_process_kill_automatically_recovers_same_run[outbox_committed] | PASSED |
| test_runtime_recovery.test_process_kill_automatically_recovers_same_run[published] | PASSED |
| test_runtime_recovery.test_process_kill_automatically_recovers_same_run[queued] | PASSED |
| test_runtime_recovery.test_process_kill_automatically_recovers_same_run[model] | PASSED |
| test_runtime_recovery.test_process_kill_automatically_recovers_same_run[provider_completed] | PASSED |
| test_runtime_recovery.test_process_kill_automatically_recovers_same_run[model_receipt] | PASSED |
| test_runtime_recovery.test_process_kill_automatically_recovers_same_run[model_saved] | PASSED |
| test_runtime_recovery.test_process_kill_automatically_recovers_same_run[completed] | PASSED |
| test_runtime_recovery.test_process_kill_automatically_recovers_same_run[result_saved] | PASSED |
| test_queue_upgrade.test_upgrade_retains_history_receipts_files_deadlines_and_only_stages_recoverable_runs | PASSED |
| test_queue_upgrade.test_startup_does_not_reset_published_outbox_or_replay_dead_letters | PASSED |
| test_task_execution.test_retry_failed_units_preserves_successes_and_replaces_failures[False] | PASSED |
| test_task_execution.test_retry_failed_units_preserves_successes_and_replaces_failures[True] | PASSED |
| test_task_execution.test_pause_between_attempts_reuses_corrections_and_budget | PASSED |
| test_task_execution.test_model_result_survives_artifact_write_failure | PASSED |
| test_task_execution.test_retry_page_preserves_successes_without_text_model_or_chunks | PASSED |
| test_evaluation.test_transient_probe_recovers_with_trace | PASSED |
| test_task_api.test_model_timeout_waits_for_explicit_resume_without_losing_receipts | PASSED |
| test_evaluation.test_unknown_model_probe_stops_with_trace | PASSED |
| test_messaging.test_shutdown_during_delivery_admission_does_not_start_execution | PASSED |
| test_messaging.test_queued_pause_stops_without_broker_and_requires_explicit_resume | PASSED |
| test_messaging.test_resume_queued_pause_preserves_selected_retry_input_or_review_command[False] | PASSED |
| test_messaging.test_resume_queued_pause_preserves_selected_retry_input_or_review_command[True] | PASSED |
| test_page_rendering.test_missing_model_fails_before_read_or_render[text] | PASSED |
| test_page_rendering.test_missing_model_fails_before_read_or_render[pdf] | PASSED |
| test_runtime.test_unsupported_tasks_are_unchanged_and_do_not_block_current_work[docx_parser-text-False] | PASSED |
| test_runtime.test_unsupported_tasks_are_unchanged_and_do_not_block_current_work[docx_parser-text-True] | PASSED |
| test_runtime.test_unsupported_tasks_are_unchanged_and_do_not_block_current_work[document_parser-docm-False] | PASSED |
| test_runtime.test_unsupported_tasks_are_unchanged_and_do_not_block_current_work[document_parser-docm-True] | PASSED |
| test_runtime.test_unsupported_tasks_are_unchanged_and_do_not_block_current_work[document_parser-xlsm-False] | PASSED |
| test_runtime.test_unsupported_tasks_are_unchanged_and_do_not_block_current_work[document_parser-xlsm-True] | PASSED |
| test_workflows.test_document_integrity_fails_before_model_call[sha256-0000000000000000000000000000000000000000000000000000000000000000-DOCUMENT_CHECKSUM_MISMATCH] | PASSED |
| test_workflows.test_document_integrity_fails_before_model_call[sizeBytes-1-DOCUMENT_SIZE_MISMATCH] | PASSED |
| test_workflows.test_structured_call_does_not_retry_permanent_errors | PASSED |
| test_task_execution.test_store_failure_stops_model_calls | PASSED |
| test_task_execution.test_retry_limits_shared_by_native_input_and_review[False-False] | PASSED |
| test_task_execution.test_retry_limits_shared_by_native_input_and_review[False-True] | PASSED |
| test_task_execution.test_retry_limits_shared_by_native_input_and_review[True-False] | PASSED |
| test_task_execution.test_retry_limits_shared_by_native_input_and_review[True-True] | PASSED |
| test_structured_output.test_corrections_keep_only_latest_output_and_stop_on_identical_failure | PASSED |
| test_chunking.test_distinct_source_positions_preserve_questions[xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxA-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxB] | PASSED |
| test_chunking.test_distinct_source_positions_preserve_questions[Record A-Record a] | PASSED |
| test_chunking.test_distinct_source_positions_preserve_questions[Repeated-Repeated] | PASSED |
| test_task_execution.test_identical_questions_on_different_pages_are_preserved | PASSED |
| test_structured_output.test_responses_wire_format_repairs_and_records_failed_usage[ {"value":1}-length] | PASSED |
| test_structured_output.test_responses_wire_format_repairs_and_records_failed_usage[{"value":-stop] | PASSED |
| test_structured_output.test_responses_wire_format_repairs_and_records_failed_usage[{"value":-1}-stop] | PASSED |
| test_evaluation.test_trajectory_ignores_parallel_completion_order_and_rejects_wrong_route | PASSED |
| test_queue_upgrade.test_startup_recovers_upgrade_interrupted_after_schema_commit[None] | PASSED |
| test_queue_upgrade.test_startup_recovers_upgrade_interrupted_after_schema_commit[started] | PASSED |
| test_queue_upgrade.test_startup_recovers_upgrade_interrupted_after_schema_commit[completed] | PASSED |
| test_production_limits.test_unknown_call_consumes_budget_after_interruption | PASSED |
| test_task_execution.test_unknown_provider_usage_is_not_recorded_as_zero | PASSED |

故障恢复分数仅代表选定的确定性测试。真实进程重启恢复：NOT_ASSESSED。

## 门禁原因


## 逐次案例

| 案例 | 次数 | 状态 | 预期匹配 | 质量合格 | 耗时 ms | 差异 |
|---|---:|---|---|---|---:|---|

Token 为已返回用量；complete=false 时不代表实际总消耗。视觉描述语义需人工复核。
完整逐题期望、实际值、阶段失败、耗时和版本信息见同名 JSON。
