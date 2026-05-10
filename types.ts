// 插件配置类型
export interface PluginSettings {
  // 目录配置
  baseFolder: string;           // 基础文件夹名称，默认 "5T-临时文件"
  successFolder: string;        // 成功原始字幕文件夹
  textOnlyFolder: string;       // 字幕纯文字文件夹
  outputFolder: string;         // 处理后文件文件夹
  logFolder: string;            // 日志文件夹
  
  // Ollama配置
  ollamaUrl: string;            // Ollama服务地址
  modelName: string;            // 模型名称
  temperature: number;          // 温度参数
  topP: number;                 // Top P参数
  
  // 处理配置
  chunkSize: number;            // 分片大小（中文字符数）
  systemPrompt: string;         // 系统提示词（字幕处理）
  summaryPrompt: string;        // 系统提示词（整体概括）
  
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

// 分片进度信息
export interface ChunkProgress {
  currentChunk: number;      // 当前分片序号
  totalChunks: number;       // 总分片数
  chunkDuration: number;     // 上一个分片处理耗时（秒）
  currentStep: ProcessingStep; // 当前处理步骤
}

// 处理步骤枚举
export type ProcessingStep = 'idle' | 'extracting' | 'processing_chunks' | 'generating_summary' | 'saving' | 'done';

// 完整进度信息
export interface FullProgress {
  fileProgress: ProcessingStatus;
  chunkProgress: ChunkProgress;
}

// 分片处理上下文
export interface ChunkContext {
  carryOver: string;            // 上一片应并入下一段的内容
  allNaturalSegments: string[];  // 所有自然分段
  allSummaries: string[];        // 所有分段总结
  allKeywords: string[];         // 所有关键词
}