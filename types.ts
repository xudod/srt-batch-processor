// 插件配置类型
export interface PluginSettings {
  // 目录配置
  baseFolder: string;           // 基础文件夹名称，默认 "5T-临时文件"
  successFolder: string;        // 成功原始字幕文件夹
  textOnlyFolder: string;       // 字幕纯文字文件夹
  outputFolder: string;         // 处理后文件文件夹
  logFolder: string;            // 日志文件夹
  
  // Herdsman配置
  herdsmanUrl: string;          // Herdsman服务地址
  modelName: string;            // 模型名称
  
  // 多步骤大模型处理配置
  processingSteps: ProcessingStepConfig[];  // 处理步骤配置列表
  
  // 状态
  isProcessing: boolean;        // 是否正在处理
  shouldStop: boolean;          // 是否停止处理
}

/**
 * 单个处理步骤配置
 */
export interface ProcessingStepConfig {
  id: string;                    // 唯一标识
  order: number;                 // 执行顺序（用于校验）
  prompt: string;                // 提示词内容
  inputSource: string;           // 输入来源：{{content}} 或 {{resultKey}}
  resultKey: string;             // 当前阶段处理结果命名（关键字）
  saveToNote: boolean;           // 是否保存至笔记
  savePath: string;              // 保存路径（空则使用默认outputFolder）
  outputOrder: number;           // 最终输出顺序
}

// 处理结果类型
export interface ProcessResult {
  fileName: string;
  success: boolean;
  error?: string;
  timestamp: string;
}

// 文件处理状态
export interface ProcessingStatus {
  total: number;
  current: number;
  currentFile: string;
  isProcessing: boolean;
}

// 处理步骤枚举（用于进度显示）
export type ProcessingStepType = 'idle' | 'extracting' | 'processing' | 'saving' | 'done';

// 为了向后兼容，导出别名
export type ProcessingStep = ProcessingStepType;
