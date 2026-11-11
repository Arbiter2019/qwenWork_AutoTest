import { Tag } from 'antd';
const labels: Record<string, string> = { queued: '排队中', submitting: '提交中', running: '运行中', waiting_retry: '等待重试', waiting_human: '等待人工', needs_review: '待人工核对', succeeded: '成功', failed: '失败', cancelled: '已取消', paused: '已暂停提交', stopping: '停止中', stopped: '已停止', completed: '已完成' };
const colors: Record<string, string> = { succeeded: 'success', failed: 'error', running: 'processing', submitting: 'processing', completed: 'success', needs_review: 'error', waiting_human: 'warning', waiting_retry: 'warning', paused: 'warning' };
export default function Status({ value }: { value: string }) { return <Tag color={colors[value]}>{labels[value] ?? value}</Tag>; }
