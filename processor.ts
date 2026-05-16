import { App, Notice, TFile, Vault, normalizePath } from 'obsidian';
import { PluginSettings, ProcessResult, ProcessingStepType, ProcessingStepConfig } from './types';
import { SubtitleExtractor } from './subtitle-extractor';
import { HerdsmanClient } from './herdsman-client';

/**
 * 进度回调类型
 */
export type ChunkStatusCallback = (
    currentChunk: number, 
    totalChunks: number, 
    chunkDuration: number,
    step: ProcessingStepType,
    stepInfo?: ProcessingStepConfig
) => void;

/**
 * 字幕处理器
 * 负责处理单个SRT文件的完整流程（支持多步骤大模型处理）
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
    private updateProgress(currentChunk: number, totalChunks: number, chunkDuration: number, step: ProcessingStepType, stepInfo?: ProcessingStepConfig) {
        if (this.onChunkProgress) {
            this.onChunkProgress(currentChunk, totalChunks, chunkDuration, step, stepInfo);
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
     * 校验处理步骤配置
     */
    validateProcessingSteps(): string[] {
        const steps = this.settings.processingSteps;
        const errors: string[] = [];

        // 检查至少有一个步骤
        if (steps.length === 0) {
            errors.push('至少需要配置一个处理步骤');
        }

        // 检查不超过9个步骤
        if (steps.length > 9) {
            errors.push('处理步骤不能超过9个');
        }

        // 检查输入来源引用是否正确
        for (const step of steps) {
            if (step.inputSource !== '{{content}}') {
                // 提取引用的关键字（支持中文）
                const match = step.inputSource.match(/\{\{(.+?)\}\}/);
                if (match) {
                    const referencedKey = match[1];
                    const hasPreviousStep = steps.some(
                        s => s.order < step.order && s.resultKey === referencedKey
                    );
                    if (!hasPreviousStep) {
                        errors.push(`步骤${step.order}的输入来源引用了不存在的关键字 "${referencedKey}"`);
                    }
                } else {
                    errors.push(`步骤${step.order}的输入来源格式不正确`);
                }
            }
        }

        // 检查结果关键字是否重复
        const keys = steps.map(s => s.resultKey);
        const uniqueKeys = new Set(keys);
        if (keys.length !== uniqueKeys.size) {
            errors.push('存在重复的结果关键字');
        }

        return errors;
    }

    /**
     * 第二步：多步骤大模型处理
     */
    private async step2MultiStepProcessing(fileName: string, originalContent: string): Promise<void> {
        // 检查输出文件是否已存在
        if (await this.isOutputExists(fileName)) {
            console.log(`输出文件已存在，跳过: ${fileName}`);
            return;
        }

        try {
            // 获取处理步骤配置并排序
            const steps = [...this.settings.processingSteps].sort((a, b) => a.order - b.order);
            
            // 存储各步骤的处理结果
            const results: Record<string, string> = {};
            // 存储需要最终输出的结果（按outputOrder排序）
            const outputResults: Array<{ step: ProcessingStepConfig; content: string }> = [];

            // 按顺序执行每个步骤
            for (let i = 0; i < steps.length; i++) {
                const step = steps[i];
                
                // 检查是否应该停止
                if (this.settings.shouldStop) {
                    throw new Error('用户停止处理');
                }

                // 通知正在处理当前步骤
                this.updateProgress(i + 1, steps.length, 0, 'processing', step);

                // 获取输入内容
                let inputContent: string;
                if (step.inputSource === '{{content}}') {
                    inputContent = originalContent;
                } else {
                    // 提取引用的关键字（支持中文）
                    const match = step.inputSource.match(/\{\{(.+?)\}\}/);
                    if (match) {
                        const referencedKey = match[1];
                        inputContent = results[referencedKey] || '';
                        if (!inputContent) {
                            throw new Error(`步骤${step.order}的输入来源 "${referencedKey}" 没有找到对应的处理结果`);
                        }
                    } else {
                        throw new Error(`步骤${step.order}的输入来源格式不正确`);
                    }
                }

                // 构建提示词（支持{{content}}和{{input}}两种占位符格式）
                const prompt = step.prompt.replace('{{content}}', inputContent).replace('{{input}}', inputContent);

                // 调用大模型处理
                const response = await this.herdsmanClient.chat(prompt, '');
                
                // 保存结果到变量
                results[step.resultKey] = response;

                // 如果需要保存到笔记
                if (step.saveToNote) {
                    // 确定保存路径
                    let savePath: string;
                    if (step.savePath) {
                        // 如果指定了保存路径
                        if (step.savePath.startsWith('/')) {
                            // 绝对路径
                            savePath = normalizePath(step.savePath);
                        } else {
                            // 相对路径（相对于基础目录）
                            savePath = normalizePath(`${this.getBasePath()}/${step.savePath}`);
                        }
                    } else {
                        // 使用默认输出目录
                        savePath = this.getOutputFolderPath();
                    }

                    // 确保保存目录存在
                    if (!await this.app.vault.adapter.exists(savePath)) {
                        await this.app.vault.adapter.mkdir(savePath);
                    }

                    // 保存文件
                    const filePath = normalizePath(`${savePath}/${fileName}_${step.resultKey}.md`);
                    if (await this.app.vault.adapter.exists(filePath)) {
                        const existingFile = this.app.vault.getFileByPath(filePath);
                        if (existingFile) {
                            await this.app.vault.modify(existingFile, response);
                        }
                    } else {
                        await this.app.vault.create(filePath, response);
                    }
                }

                // 添加到最终输出列表（按outputOrder排序）
                outputResults.push({ step, content: response });

                console.log(`步骤${step.order}处理完成: ${step.resultKey}`);
            }

            // 通知正在保存最终结果
            this.updateProgress(0, 1, 0, 'saving');

            // 按outputOrder排序并合并最终结果
            outputResults.sort((a, b) => a.step.outputOrder - b.step.outputOrder);

            // 构建最终文件内容
            const finalContentParts: string[] = [];
            outputResults.forEach((item, index) => {
                if (index > 0) {
                    finalContentParts.push('\n\n---\n\n'); // 添加分隔线
                }
                finalContentParts.push(`## ${item.step.resultKey}\n\n`);
                finalContentParts.push(item.content);
            });

            const finalContent = finalContentParts.join('');

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
            console.error(`多步骤处理失败: ${fileName}`, error);
            throw error;
        }
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
        
        const timestamp = new Date().toLocaleString('zh-CN');
        const divider = '\n\n---\n\n';
        
        let logContent = `## 失败文件: ${fileName}\n\n`;
        logContent += `**失败时间**: ${timestamp}\n\n`;
        logContent += `**失败原因**: ${error.message}\n\n`;
        
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

            // 获取纯文本内容
            const pureText = await this.getPureText(fileName);
            
            if (!pureText || pureText.trim().length === 0) {
                throw new Error('纯文本内容为空');
            }
            
            // 第二步：多步骤大模型处理
            await this.step2MultiStepProcessing(fileName, pureText);
            
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

        // 校验配置
        const validationErrors = this.validateProcessingSteps();
        if (validationErrors.length > 0) {
            const errorMessage = validationErrors.join('\n');
            new Notice(`配置校验失败:\n${errorMessage}`, 10000);
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
