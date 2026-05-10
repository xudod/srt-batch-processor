import { App, Notice, TFile, Vault, normalizePath } from 'obsidian';
import { PluginSettings, ChunkResponse, ProcessResult, ChunkContext } from './types';
import { SubtitleExtractor } from './subtitle-extractor';
import { OllamaClient } from './ollama-client';

/**
 * 字幕处理器
 * 负责处理单个SRT文件的完整流程
 */
export class SubtitleProcessor {
    private app: App;
    private settings: PluginSettings;
    private ollamaClient: OllamaClient;
    private onStatusUpdate?: (currentFile: string, current: number, total: number) => void;

    constructor(app: App, settings: PluginSettings, ollamaClient: OllamaClient) {
        this.app = app;
        this.settings = settings;
        this.ollamaClient = ollamaClient;
    }

    /**
     * 设置状态更新回调
     */
    setStatusCallback(callback: (currentFile: string, current: number, total: number) => void) {
        this.onStatusUpdate = callback;
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
     * 第二步：获取纯文本内容
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
     * 大模型分片处理
     */
    private async processWithChunks(
        text: string, 
        systemPrompt: string
    ): Promise<{ segments: string[]; summaries: string[]; keywords: string[]; finalText: string }> {
        // 分片
        const chunks = SubtitleExtractor.splitByChineseChars(text, this.settings.chunkSize);
        console.log(`文本分片: 共 ${chunks.length} 片`);
        
        const context: ChunkContext = {
            carryOver: '',
            allNaturalSegments: [],
            allSummaries: [],
            allKeywords: []
        };
        
        // 逐片处理
        for (let i = 0; i < chunks.length; i++) {
            let chunkContent = chunks[i];
            
            // 合并上一片的"应并入下一段"
            if (context.carryOver) {
                chunkContent = context.carryOver + '\n\n' + chunkContent;
                context.carryOver = '';
            }
            
            console.log(`处理分片 ${i + 1}/${chunks.length}，长度: ${chunkContent.length} 字符`);
            
            try {
                const response: ChunkResponse = await this.ollamaClient.processChunk(
                    systemPrompt,
                    chunkContent
                );
                
                // 收集结果
                if (response.自然分段) {
                    context.allNaturalSegments.push(response.自然分段);
                }
                if (response.分段总结) {
                    context.allSummaries.push(response.分段总结);
                }
                if (response.关键字 && response.关键字.length > 0) {
                    context.allKeywords.push(...response.关键字);
                }
                if (response.应并入下一段) {
                    context.carryOver = response.应并入下一段;
                }
                
                // 检查是否需要停止
                if (this.settings.shouldStop) {
                    throw new Error('用户停止处理');
                }
            } catch (error) {
                console.error(`分片 ${i + 1} 处理失败:`, error);
                throw error;
            }
        }
        
        // 处理最后剩余的应并入内容
        if (context.carryOver) {
            context.allNaturalSegments.push(context.carryOver);
        }
        
        // 去重关键字
        const uniqueKeywords = [...new Set(context.allKeywords)];
        
        // 合并自然分段
        const finalText = context.allNaturalSegments.join('\n\n');
        
        return {
            segments: context.allNaturalSegments,
            summaries: context.allSummaries,
            keywords: uniqueKeywords,
            finalText: finalText
        };
    }

    /**
     * 第三步：大模型处理并生成最终文件
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
            
            // 分片处理
            const { summaries, keywords, finalText } = await this.processWithChunks(
                pureText,
                this.settings.systemPrompt
            );
            
            // 生成整体概括
            let overallSummary = '';
            if (summaries.length > 0 && this.settings.summaryPrompt) {
                try {
                    overallSummary = await this.ollamaClient.generateOverallSummary(
                        this.settings.summaryPrompt,
                        summaries
                    );
                } catch (error) {
                    console.error('生成整体概括失败:', error);
                    overallSummary = '整体概括生成失败';
                }
            }
            
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
    private async logFailure(fileName: string, error: Error, originalFilePath: string): Promise<void> {
        const logFilePath = normalizePath(`${this.getLogFolderPath()}/log.txt`);
        
        const logEntry = {
            文件名: fileName,
            失败时间: new Date().toLocaleString('zh-CN'),
            失败原因: error.message
        };
        
        const logText = JSON.stringify(logEntry, null, 2) + '\n---\n';
        
        // 追加日志
        if (await this.app.vault.adapter.exists(logFilePath)) {
            const existingLog = await this.app.vault.adapter.read(logFilePath);
            await this.app.vault.adapter.write(logFilePath, logText + existingLog);
        } else {
            await this.app.vault.create(logFilePath, logText);
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
                    new Notice('用户已停止处理');
                    break;
                }
                
                const result = await this.processFile(srtFiles[i], i + 1, srtFiles.length);
                results.push(result);
                
                // 显示进度
                new Notice(`已完成: ${i + 1}/${srtFiles.length} - ${result.success ? '✓' : '✗'} ${result.fileName}`);
            }
        } finally {
            this.settings.isProcessing = false;
            this.settings.shouldStop = false;
        }
        
        // 显示最终结果
        const successCount = results.filter(r => r.success).length;
        const failCount = results.filter(r => !r.success).length;
        new Notice(`处理完成！成功: ${successCount}, 失败: ${failCount}`);
        
        return results;
    }

    /**
     * 停止处理
     */
    stopProcessing(): void {
        this.settings.shouldStop = true;
        new Notice('正在停止处理，当前文件完成后将停止...');
    }
}