import { Image, RichText, Text, View } from "@tarojs/components";
import type { ContentBlock, QuestionOption, QuestionRecord } from "../api/modules";

export function QuestionContent({ question, revealAnswer = false }: { question: Pick<QuestionRecord, "stem" | "options" | "analysis" | "content_blocks">; revealAnswer?: boolean }): JSX.Element {
  return <View className="app-stack"><Text className="question-stem">{question.stem}</Text>{question.content_blocks?.map((block) => <Block key={`${block.sequence}-${block.part_type}`} block={block} />)}{question.options?.length ? <View className="app-stack">{question.options.map((option) => <Option key={option.id ?? option.option_label} option={option} reveal={revealAnswer} />)}</View> : null}{revealAnswer && question.analysis ? <View className="form-card"><Text className="form-label">解析</Text><Text className="app-muted">{question.analysis}</Text></View> : null}</View>;
}

function Option({ option, reveal }: { option: QuestionOption; reveal: boolean }): JSX.Element {
  return <View className={`answer-option ${reveal && option.is_correct ? "answer-option-active" : ""}`}><Text className="form-label">{option.option_label}</Text><Text>{option.content}</Text></View>;
}

function Block({ block }: { block: ContentBlock }): JSX.Element {
  const payload = block.payload;
  if (block.part_type === "image" && typeof payload.url === "string") return <Image src={payload.url} mode="widthFix" style={{ width: "100%" }} />;
  if (block.part_type === "html" && typeof payload.html === "string") return <RichText nodes={payload.html} />;
  const text = typeof payload.text === "string" ? payload.text : typeof payload.content === "string" ? payload.content : JSON.stringify(payload);
  return <Text className={block.part_type === "formula" ? "app-number" : "app-muted"}>{text}</Text>;
}
