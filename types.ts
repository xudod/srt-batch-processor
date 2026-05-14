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
  
  // 处理配置
  systemPrompt: string;         // 系统提示词（字幕处理）
  
  // 状态
  isProcessing: boolean;        // 是否正在处理
  shouldStop: boolean;          // 是否停止处理
}

// 大模型响应类型（分片处理）
export interface ChunkResponse {
  自然分段: string;
  分段总结: string;
  关键字: string[];
  应并入下一段: string;
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

// 处理步骤枚举
export type ProcessingStep = 'idle' | 'extracting' | 'processing' | 'generating_summary' | 'saving' | 'done';