import {
  protectedPage,
  usePageLoad,
  usePageApi,
} from "../../../../auth/protected-page";
import { Button } from "@taroify/core";
import { Picker, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { useRef, useState } from "react";
import type { BankRecord } from "../../../../api/modules";
import { errorMessage } from "../../../../api/message";
import {
  ErrorNotice,
  Page,
  PageHeader,
  Section,
  confirmDanger,
} from "../../../../components/ui";
import {
  pendingTransfers,
  identifyTransferFile,
  verifyTransferFile,
} from "../../../../transfers/runtime";
import type { TransferFile } from "../../../../transfers/pending-transfers";

function ImportCreatePage(): JSX.Element {
  const api = usePageApi();
  const scope = useRef(pendingTransfers.scope()).current;
  const restored = pendingTransfers.importFor(scope);
  const [banks, setBanks] = useState<BankRecord[]>([]);
  const [bankId, setBankId] = useState<number | null>(restored?.bankId ?? null);
  const selectedBank = useRef(bankId);
  const [file, setFile] = useState<TransferFile | null>(restored?.file ?? null);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const restore = async (target: number) => {
    await api.banks.get(target);
    if (selectedBank.current !== target) return;
    const pending = pendingTransfers.importFor(scope, target);
    if (!pending) return;
    if (pending.jobId) await api.imports.get(pending.jobId);
    if (selectedBank.current !== target) return;
    setFile(pending.file);
    setMessage(
      `已恢复原操作${pending.jobId ? `，任务 #${pending.jobId}` : "（创建结果尚未确认）"}。继续前会重新查验，不会盲目新建。`,
    );
    if (pending.stage !== "parse") await verifyTransferFile(pending.file);
  };
  usePageLoad(async () => {
    try {
      const page = await api.banks.list({ scope: "mine", limit: 100 });
      setBanks(page.items);
      const target = bankId ?? restored?.bankId ?? page.items[0]?.id;
      if (target) {
        selectedBank.current = target;
        setBankId(target);
        await restore(target);
      }
    } catch (error) {
      setMessage(errorMessage(error));
    }
  });
  const abandon = async (): Promise<boolean> => {
    const pending = bankId
      ? pendingTransfers.importFor(scope, bankId)
      : undefined;
    if (!pending) return true;
    if (
      !(await confirmDanger(
        "放弃本地导入恢复",
        "只清除本地操作参数，不会取消、删除或退款服务端任务。请先核对已有任务；重新开始将使用新 key。",
        "放弃",
      ))
    )
      return false;
    pendingTransfers.endImport(pending);
    setFile(null);
    setMessage("本地恢复已结束，服务端任务不受影响。");
    return true;
  };
  const choose = async () => {
    try {
      if (!(await abandon())) return;
      const result = await Taro.chooseMessageFile({ count: 1, type: "all" });
      const chosen = result.tempFiles[0];
      if (chosen) {
        const selected = await identifyTransferFile(chosen.path, chosen.name);
        pendingTransfers.check(scope);
        setFile(selected);
      }
    } catch (error) {
      setMessage(errorMessage(error));
    }
  };
  const selectBank = async (target: number) => {
    selectedBank.current = target;
    setBankId(target);
    setFile(pendingTransfers.importFor(scope, target)?.file ?? null);
    setMessage("");
    try {
      await restore(target);
    } catch (error) {
      setMessage(errorMessage(error));
    }
  };
  const create = async () => {
    if (!bankId || !file) {
      setMessage("请选择题库和文件");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      const pending = pendingTransfers.beginImport(scope, bankId, file);
      const id = await pendingTransfers.runImport(
        api,
        pending,
        verifyTransferFile,
      );
      setFile(null);
      await Taro.redirectTo({
        url: `/packages/tools/imports/detail/index?id=${id}`,
      });
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setLoading(false);
    }
  };
  const pending = bankId
    ? pendingTransfers.importFor(scope, bankId)
    : undefined;
  return (
    <Page>
      <PageHeader
        eyebrow="AI 导入"
        title="上传题目文件"
        subtitle="恢复只保留本次运行内已发起操作的参数，不会自动取消服务端任务。"
      />
      <Section title="导入信息">
        <View className="form-card">
          <View className="form-field">
            <Text className="form-label">目标题库</Text>
            <Picker
              disabled={loading}
              mode="selector"
              range={banks.map((bank) => bank.name)}
              onChange={(event) => {
                const target = banks[Number(event.detail.value)]?.id;
                if (target) void selectBank(target);
              }}
            >
              <View className="form-input">
                {banks.find((bank) => bank.id === bankId)?.name || "请选择"}
              </View>
            </Picker>
          </View>
          <View className="form-field">
            <Text className="form-label">文件</Text>
            <Button disabled={loading} onClick={() => void choose()}>
              {file?.name || "选择文件"}
            </Button>
          </View>
          {message ? <ErrorNotice>{message}</ErrorNotice> : null}
          <Button
            color="primary"
            block
            shape="round"
            loading={loading}
            disabled={loading}
            onClick={() => void create()}
          >
            {pending ? "继续已发起操作" : "上传并开始解析"}
          </Button>
          {pending ? (
            <Button disabled={loading} onClick={() => void abandon()}>
              放弃本地导入恢复
            </Button>
          ) : null}
        </View>
      </Section>
    </Page>
  );
}

export default protectedPage(ImportCreatePage);
