import { App, Notice, TFile, Vault, normalizePath } from 'obsidian';
import { PluginSettings, ProcessResult, ProcessingStep } from './types';
import { SubtitleExtractor } from './subtitle-extractor';
import { HerdsmanClient, JsonParseError } from './herdsman-client';

/**
 * 进度回调类型
 */
export type ChunkStatusCallback = (
    currentChunk: number, 
    totalChunks: number, 
    chunkDuration: number,
    step: ProcessingStep
) => void;

/**
 * 字幕处理器
 * 负责处理单个SRT文件的完整流程
 */
export class SubtitleProcessor {
    private app: App;
    private settings: PluginSettings;
    private herdsmanClient: HerdsmanClient;
    private onStatusUpdate?: (currentFile: string, current: number, total: number) => void;
    private onChunkProgress?: ChunkStatusCallback;

    constructor(app: App, settings: PluginSettings, herdsmanClient: HerdsmanClient) {
        this.app = app;
        this.settings = settings;
        this.herdsmanClient = herdsmanClient;
    }

    /**
     * 设置状态更新回调（文件级别）
     */
    setStatusCallback(callback: (currentFile: string, current: number, total: number) => void) {
        this.onStatusUpdate = callback;
    }

    /**
     * 设置进度回调
     */
    setChunkProgressCallback(callback: ChunkStatusCallback) {
        this.onChunkProgress = callback;
    }

    /**
     * 更新进度
     */
    private updateProgress(currentChunk: number, totalChunks: number, chunkDuration: number, step: ProcessingStep) {
        if (this.onChunkProgress) {
            this.onChunkProgress(currentChunk, totalChunks, chunkDuration, step);
        }
    }

    /**
     * 获取基础目录路径
     */
    private getBasePath(): string {
        return normalizePath(this.settings.baseFolder);
    }

    /**
     * 获取各子目录路径
     */
    private getSuccessFolderPath(): string {
        return normalizePath(`${this.getBasePath()}/${this.settings.successFolder}`);
    }

    private getTextOnlyFolderPath(): string {
        return normalizePath(`${this.getBasePath()}/${this.settings.textOnlyFolder}`);
    }

    private getOutputFolderPath(): string {
        return normalizePath(`${this.getBasePath()}/${this.settings.outputFolder}`);
    }

    private getLogFolderPath(): string {
        return normalizePath(`${this.getBasePath()}/${this.settings.logFolder}`);
    }

    /**
     * 确保目录存在
     */
    private async ensureDirectories(): Promise<void> {
        const paths = [
            this.getBasePath(),
            this.getSuccessFolderPath(),
            this.getTextOnlyFolderPath(),
            this.getOutputFolderPath(),
            this.getLogFolderPath()
        ];

        for (const path of paths) {
            const dirExists = await this.app.vault.adapter.exists(path);
            if (!dirExists) {
                await this.app.vault.adapter.mkdir(path);
                console.log(`Created directory: ${path}`);
            }
        }
    }

    /**
     * 获取需要处理的SRT文件列表
     */
    async getSRTFiles(): Promise<TFile[]> {
        const basePath = this.getBasePath();
        const files: TFile[] = [];
        
        const items = await this.app.vault.adapter.list(basePath);
        
        for (const filePath of items.files) {
            if (SubtitleExtractor.isValidSRTFile(filePath)) {
                const file = this.app.vault.getFileByPath(filePath);
                if (file) {
                    files.push(file);
                }
            }
        }
        
        return files;
    }

    /**
     * 检查文件是否已处理
     */
    private async isTextOnlyExists(fileName: string): Promise<boolean> {
        const textOnlyPath = normalizePath(`${this.getTextOnlyFolderPath()}/${fileName}.md`);
        return await this.app.vault.adapter.exists(textOnlyPath);
    }

    /**
     * 检查输出文件是否已存在
     */
    private async isOutputExists(fileName: string): Promise<boolean> {
        const outputPath = normalizePath(`${this.getOutputFolderPath()}/${fileName}.md`);
        return await this.app.vault.adapter.exists(outputPath);
    }

    /**
     * 第一步：提取纯文字并保存
     */
    private async step1ExtractText(srtFile: TFile): Promise<boolean> {
        const fileName = SubtitleExtractor.getFileNameWithoutExtension(srtFile.name);
        
        // 通知正在提取文字
        this.updateProgress(0, 1, 0, 'extracting');
        
        // 检查是否已存在纯文字文件
        if (await this.isTextOnlyExists(fileName)) {
            console.log(`纯文字文件已存在，跳过: ${fileName}`);
            return true;
        }
        
        try {
            // 读取SRT文件并提取纯文字
            const content = await this.app.vault.read(srtFile);
            const pureText = SubtitleExtractor.extractPureText(content);
            
            // 保存到110-字幕纯文字目录
            const textOnlyPath = normalizePath(`${this.getTextOnlyFolderPath()}/${fileName}.md`);
            
            // 确保文件存在或创建
            if (await this.app.vault.adapter.exists(textOnlyPath)) {
                const existingFile = this.app.vault.getFileByPath(textOnlyPath);
                if (existingFile) {
                    await this.app.vault.modify(existingFile, pureText);
                }
            } else {
                await this.app.vault.create(textOnlyPath, pureText);
            }
            
            // 移动原始SRT文件到成功目录
            const successPath = normalizePath(`${this.getSuccessFolderPath()}/${srtFile.name}`);
            await this.app.vault.rename(srtFile, successPath);
            
            return true;
        } catch (error) {
            console.error(`提取文字失败: ${srtFile.name}`, error);
            throw new Error(`提取文字失败: ${error.message}`);
        }
    }

    /**
     * 获取纯文本内容
     */
    private async getPureText(fileName: string): Promise<string> {
        const textOnlyPath = normalizePath(`${this.getTextOnlyFolderPath()}/${fileName}.md`);
        const file = this.app.vault.getFileByPath(textOnlyPath);
        
        if (!file) {
            throw new Error(`纯文字文件不存在: ${textOnlyPath}`);
        }
        
        return await this.app.vault.read(file);
    }

    /**
     * 第二步：大模型处理并生成最终文件
     */
    private async step2ProcessWithLLM(fileName: string): Promise<void> {
        // 检查输出文件是否已存在
        if (await this.isOutputExists(fileName)) {
            console.log(`输出文件已存在，跳过: ${fileName}`);
            return;
        }
        
        try {
            // 获取纯文本
            const pureText = await this.getPureText(fileName);
            
            if (!pureText || pureText.trim().length === 0) {
                throw new Error('纯文本内容为空');
            }
            
            // 通知正在处理
            this.updateProgress(0, 1, 0, 'processing');
            
            // 调用大模型处理（不分片，一次性处理）
            const response = await this.herdsmanClient.processText(
                this.settings.systemPrompt,
                pureText
            );
            
            const summaries = response.分段总结 ? [response.分段总结] : [];
            const keywords = Array.isArray(response.关键字) ? response.关键字 : [];
            const finalText = response.自然分段 || '';
            
            // 生成整体概括
            let overallSummary = '';
            if (summaries.length > 0 && this.settings.summaryPrompt) {
                // 通知正在生成整体概括
                this.updateProgress(0, 1, 0, 'generating_summary');
                
                try {
                    overallSummary = await this.herdsmanClient.generateOverallSummary(
                        this.settings.summaryPrompt,
                        summaries
                    );
                } catch (error) {
                    console.error('生成整体概括失败:', error);
                    overallSummary = '整体概括生成失败';
                }
            }
            
            // 通知正在保存结果
            this.updateProgress(0, 1, 0, 'saving');
            
            // 构建最终文件内容
            const finalContent = this.buildFinalContent(overallSummary, keywords, summaries, finalText);
            
            // 保存到输出目录
            const outputPath = normalizePath(`${this.getOutputFolderPath()}/${fileName}.md`);
            
            if (await this.app.vault.adapter.exists(outputPath)) {
                const existingFile = this.app.vault.getFileByPath(outputPath);
                if (existingFile) {
                    await this.app.vault.modify(existingFile, finalContent);
                }
            } else {
                await this.app.vault.create(outputPath, finalContent);
            }
            
            // 通知处理完成
            this.updateProgress(1, 1, 0, 'done');
            
        } catch (error) {
            console.error(`LLM处理失败: ${fileName}`, error);
            throw error;
        }
    }

    /**
     * 构建最终文件内容
     */
    private buildFinalContent(
        overallSummary: string,
        keywords: string[],
        summaries: string[],
        finalText: string
    ): string {
        const parts: string[] = [];
        
        // 一级标题：整体概括
        parts.push('# 整体概括\n');
        parts.push(overallSummary || '无整体概括内容\n');
        
        // 一级标题：关键字
        parts.push('\n# 关键字\n');
        if (keywords.length > 0) {
            parts.push(keywords.map(k => `- ${k}`).join('\n'));
        } else {
            parts.push('无关键字');
        }
        
        // 一级标题：分段总结
        parts.push('\n# 分段总结\n');
        if (summaries.length > 0) {
            summaries.forEach((summary, index) => {
                parts.push(`\n## 第${index + 1}部分\n`);
                parts.push(summary);
            });
        } else {
            parts.push('无分段总结');
        }
        
        // 一级标题：自然分段内容
        parts.push('\n# 自然分段内容\n');
        parts.push(finalText || '无内容');
        
        return parts.join('');
    }

    /**
     * 记录失败日志
     */
    private async logFailure(
        fileName: string, 
        error: Error, 
        originalFilePath: string
    ): Promise<void> {
        const logFilePath = normalizePath(`${this.getLogFolderPath()}/log.md`);
        
        let originalResponse = '';
        let errorDetails = error.message;
        
        if ('originalResponse' in error && typeof (error as any).originalResponse === 'string') {
            originalResponse = (error as any).originalResponse as string;
        }
        
        const timestamp = new Date().toLocaleString('zh-CN');
        const divider = '---\n';
        
        let logContent = `## 失败文件: ${fileName}\n\n`;
        logContent += `**失败时间**: ${timestamp}\n\n`;
        logContent += `**失败原因**: ${errorDetails}\n\n`;
        
        if (originalResponse) {
            logContent += `**LLM 原始响应**:\n\`\`\`json\n${originalResponse}\n\`\`\`\n\n`;
        }
        
        logContent += divider;
        
        // 追加日志到文件
        if (await this.app.vault.adapter.exists(logFilePath)) {
            const existingLog = await this.app.vault.adapter.read(logFilePath);
            await this.app.vault.adapter.write(logFilePath, logContent + existingLog);
        } else {
            await this.app.vault.create(logFilePath, logContent);
        }
        
        // 移动原始SRT文件到日志目录
        try {
            const originalFile = this.app.vault.getFileByPath(originalFilePath);
            if (originalFile) {
                const logFileName = `${fileName}_failed_${Date.now()}.srt`;
                const logDestPath = normalizePath(`${this.getLogFolderPath()}/${logFileName}`);
                await this.app.vault.rename(originalFile, logDestPath);
            }
        } catch (moveError) {
            console.error('移动失败文件出错:', moveError);
        }
    }

    /**
     * 处理单个文件
     */
    async processFile(srtFile: TFile, currentIndex: number, totalCount: number): Promise<ProcessResult> {
        const fileName = SubtitleExtractor.getFileNameWithoutExtension(srtFile.name);
        const result: ProcessResult = {
            fileName: fileName,
            success: false,
            timestamp: new Date().toISOString()
        };
        
        try {
            // 更新状态栏
            if (this.onStatusUpdate) {
                this.onStatusUpdate(fileName, currentIndex, totalCount);
            }
            
            // 检查是否应该停止
            if (this.settings.shouldStop) {
                throw new Error('用户停止处理');
            }
            
            // 第一步：提取文字
            await this.step1ExtractText(srtFile);
            
            // 再次检查是否停止
            if (this.settings.shouldStop) {
                throw new Error('用户停止处理');
            }
            
            // 第二步：大模型处理
            await this.step2ProcessWithLLM(fileName);
            
            result.success = true;
            
        } catch (error) {
            result.success = false;
            result.error = error.message;
            
            // 记录失败日志
            await this.logFailure(fileName, error, srtFile.path);
        }
        
        return result;
    }

    /**
     * 批量处理所有文件
     */
    async processAllFiles(): Promise<ProcessResult[]> {
        // 确保目录存在
        await this.ensureDirectories();
        
        // 获取所有SRT文件
        const srtFiles = await this.getSRTFiles();
        
        if (srtFiles.length === 0) {
            new Notice('未找到任何SRT字幕文件');
            return [];
        }
        
        this.settings.isProcessing = true;
        this.settings.shouldStop = false;
        
        const results: ProcessResult[] = [];
        
        try {
            for (let i = 0; i < srtFiles.length; i++) {
                // 检查停止标志
                if (this.settings.shouldStop) {
                    break;
                }
                
                const result = await this.processFile(srtFiles[i], i + 1, srtFiles.length);
                results.push(result);
                
                console.log(`已完成: ${i + 1}/${srtFiles.length} - ${result.success ? '✓' : '✗'} ${result.fileName}`);
            }
        } finally {
            this.settings.isProcessing = false;
            this.settings.shouldStop = false;
        }
        
        return results;
    }

    /**
     * 停止处理
     */
    stopProcessing(): void {
        this.settings.shouldStop = true;
    }
}