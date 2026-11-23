import type { EvalTaskStatus } from '@prisma/client';
import { targetConnectionState } from './connection.js';

/** 检测流程环节：模型接入 → 样本库 → 启动 → 运行 → 复核 → 报告。 */
export type ReadinessStageKey = 'target' | 'questions' | 'start' | 'run' | 'review' | 'report';
export type ReadinessState = 'done' | 'active' | 'pending' | 'failed' | 'warn';

export interface ReadinessStage {
  key: ReadinessStageKey;
  label: string;
  state: ReadinessState;
  detail: string;
}

export interface ReadinessTaskInput {
  id: string;
  name: string;
  status: EvalTaskStatus;
  startedAt: Date | null;
  totalQuestions: number;
  questionSetCount: number;
  reportCount: number;
  findingCount: number;
  pendingReviewCount: number;
  modelTargetId: string | null;
  modelTarget: {
    name: string;
    isActive: boolean;
    lastTestStatus: string | null;
  } | null;
}

const STAGE_LABELS: Record<ReadinessStageKey, string> = {
  target: '模型接入',
  questions: '样本库',
  start: '启动',
  run: '运行',
  review: '复核',
  report: '报告',
};

const RUN_STATUS_DETAIL: Record<EvalTaskStatus, [ReadinessState, string]> = {
  PENDING: ['pending', '排队中'],
  RUNNING: ['active', '执行中'],
  PAUSED: ['warn', '已暂停'],
  COMPLETED: ['done', '已完成'],
  FAILED: ['failed', '失败'],
  CANCELED: ['warn', '已取消'],
};

function stage(key: ReadinessStageKey, state: ReadinessState, detail: string): ReadinessStage {
  return { key, label: STAGE_LABELS[key], state, detail };
}

export function startStatusLabel(task: Pick<ReadinessTaskInput, 'status' | 'startedAt'>): string {
  if (task.startedAt) return '已启动';
  if (task.status === 'PENDING') return '待启动';
  if (task.status === 'CANCELED') return '未启动（已取消）';
  return '未启动';
}

export function buildReadinessRow(task: ReadinessTaskInput) {
  const target = task.modelTarget;
  const connectionState = target ? targetConnectionState(target) : null;
  const targetStage =
    connectionState === null
      ? stage('target', 'failed', '未关联模型')
      : connectionState === 'inactive'
        ? stage('target', 'failed', '模型已停用')
        : connectionState === 'ok'
          ? stage('target', 'done', '连通性正常')
          : connectionState === 'failed'
            ? stage('target', 'warn', '最近连通测试失败')
            : // 未做连通测试属于「待测试」，不算需关注/异常
              stage('target', 'pending', '未做连通测试');

  const questionsStage =
    task.totalQuestions > 0 || task.questionSetCount > 0
      ? stage('questions', 'done', `${task.totalQuestions} 条样本`)
      : stage('questions', 'pending', '样本未就绪');

  const startStage = task.startedAt
    ? stage('start', 'done', '已启动')
    : task.status === 'PENDING'
      ? stage('start', 'pending', '待启动')
      : stage('start', 'warn', startStatusLabel(task));

  const [runState, runDetail] = RUN_STATUS_DETAIL[task.status];
  const runStage = stage('run', runState, runDetail);

  const reviewStage =
    task.status !== 'COMPLETED'
      ? stage('review', 'pending', '待运行完成')
      : task.findingCount === 0
        ? stage('review', 'done', '无风险发现')
        : task.pendingReviewCount > 0
          ? stage('review', 'active', `待复核 ${task.pendingReviewCount} 项`)
          : stage('review', 'done', '复核完成');

  const reportStage =
    task.reportCount > 0
      ? stage('report', 'done', `已生成 ${task.reportCount} 份`)
      : reviewStage.state === 'done'
        ? stage('report', 'active', '可生成报告')
        : stage('report', 'pending', '未生成');

  return {
    taskId: task.id,
    taskName: task.name,
    modelName: target?.name ?? '—',
    modelTargetId: task.modelTargetId,
    connectionState,
    startStatus: startStatusLabel(task),
    runStatus: task.status,
    stages: [targetStage, questionsStage, startStage, runStage, reviewStage, reportStage],
  };
}
