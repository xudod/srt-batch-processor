import { App, Notice, Plugin, PluginManifest, TFile, addIcon, Notice as ObsidianNotice } from 'obsidian';
import { PluginSettings, ProcessResult, ProcessingStatus, ProcessingStep, ProcessingStepConfig } from './types';
import { SubtitleProcessorSettingTab, DEFAULT_SETTINGS } from './settings';
import { SubtitleProcessor } from './processor';
import { HerdsmanClient } from './herdsman-client';

// 自定义图标（停止图标）
const STOP_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2" ry="2"></rect></svg>`;
const PLAY_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`;

// 处理步骤中文映射
const STEP_LABELS: Record<ProcessingStep, string> = {
  idle: '空闲',
  extracting: '提取文字',
  processing: 'AI处理',
  saving: '保存结果',
  done: '完成'
};

export default class NianHuaSaiBoXingProcessor extends Plugin {
  settings: PluginSettings;
  private processor: SubtitleProcessor | null = null;
  private herdsmanClient: HerdsmanClient | null = null;
  private statusBarItem: HTMLElement | null = null;
  private ribbonIcon: HTMLElement | null = null;
  private processingInterval: NodeJS.Timeout | null = null;
  
  // 进度状态
  private currentStep: ProcessingStep = 'idle';
  private currentFileName: string = '';
  private currentStepInfo: ProcessingStepConfig | null = null;
  private currentChunk: number = 0;
  private totalChunks: number = 0;

  async onload() {
    await this.loadSettings();
    
    // 初始化Herdsman客户端
    this.herdsmanClient = new HerdsmanClient(
      this.settings.herdsmanUrl,
      this.settings.modelName
    );
    
    // 初始化处理器
    this.processor = new SubtitleProcessor(this.app, this.settings, this.herdsmanClient);
    
    // 设置状态更新回调（文件级别）
    this.processor.setStatusCallback((currentFile: string, current: number, total: number) => {
      this.currentFileName = currentFile;
      this.updateStatusBar(currentFile, current, total);
    });
    
    // 设置进度回调
    this.processor.setChunkProgressCallback((currentChunk, totalChunks, chunkDuration, step, stepInfo) => {
      this.currentStep = step;
      this.currentChunk = currentChunk;
      this.totalChunks = totalChunks;
      this.currentStepInfo = stepInfo || null;
      this.updateStatusBar(this.currentFileName, 0, 0); // 刷新显示
    });
    
    // 添加自定义图标
    addIcon('stop-circle', STOP_ICON);
    addIcon('play-circle', PLAY_ICON);
    
    // 添加丝带图标（停止按钮）
    this.ribbonIcon = this.addRibbonIcon('stop-circle', '停止字幕处理', () => {
      this.stopProcessing();
    });
    this.ribbonIcon.addClass('nianshua-stop-button');
    
    // 添加状态栏
    this.statusBarItem = this.addStatusBarItem();
    this.statusBarItem.addClass('nianshua-status-bar');
    this.statusBarItem.setText('拈花赛博行就绪');
    this.statusBarItem.onClickEvent(() => {
      this.startProcessing();
    });
    
    // 添加命令
    this.addCommand({
      id: 'start-subtitle-processing',
      name: '开始处理字幕文件',
      callback: () => this.startProcessing()
    });
    
    this.addCommand({
      id: 'stop-subtitle-processing',
      name: '停止处理字幕文件',
      callback: () => this.stopProcessing()
    });
    
    // 添加设置页面
    this.addSettingTab(new SubtitleProcessorSettingTab(this.app, this));
    
    // 启动时检查配置
    this.checkConfiguration();
  }
  
  async onunload() {
    // 清理定时器
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
    }
    
    // 清理状态栏
    if (this.statusBarItem) {
      this.statusBarItem.remove();
    }
    
    // 清理丝带图标
    if (this.ribbonIcon) {
      this.ribbonIcon.remove();
    }
  }
  
  /**
   * 加载设置
   */
  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  
  /**
   * 保存设置
   */
  async saveSettings() {
    await this.saveData(this.settings);
    
    // 更新客户端配置
    if (this.herdsmanClient) {
      this.herdsmanClient.updateConfig(
        this.settings.herdsmanUrl,
        this.settings.modelName
      );
    }
    
    // 更新处理器
    if (this.processor) {
      this.processor = new SubtitleProcessor(this.app, this.settings, this.herdsmanClient!);
      this.processor.setStatusCallback((currentFile: string, current: number, total: number) => {
        this.currentFileName = currentFile;
        this.updateStatusBar(currentFile, current, total);
      });
      this.processor.setChunkProgressCallback((currentChunk, totalChunks, chunkDuration, step, stepInfo) => {
        this.currentStep = step;
        this.currentChunk = currentChunk;
        this.totalChunks = totalChunks;
        this.currentStepInfo = stepInfo || null;
        this.updateStatusBar(this.currentFileName, 0, 0);
      });
    }
  }
  
  /**
   * 检查配置是否完整
   */
  private checkConfiguration(): void {
    if (!this.settings.modelName) {
      console.warn('未配置Herdsman模型，请在设置中选择模型');
    }
    
    // 检查处理步骤配置
    if (!this.settings.processingSteps || this.settings.processingSteps.length === 0) {
      console.warn('未配置处理步骤，请在设置中添加处理步骤');
    } else {
      // 检查每个步骤的提示词是否包含 {{input}} 占位符
      this.settings.processingSteps.forEach((step, index) => {
        if (!step.prompt || !step.prompt.includes('{{input}}')) {
          console.warn(`步骤${index + 1}的提示词中未包含 {{input}} 占位符，可能导致处理异常`);
        }
      });
    }
  }
  
  /**
   * 验证处理前条件
   */
  private async validateBeforeProcessing(): Promise<boolean> {
    // 检查是否已在处理
    if (this.settings.isProcessing) {
      new Notice('已有处理任务在进行中，请勿重复启动');
      return false;
    }
    
    // 检查模型配置
    if (!this.settings.modelName) {
      new Notice('请先在设置中配置Herdsman模型');
      return false;
    }
    
    // 测试Herdsman连接
    if (this.herdsmanClient) {
      const isConnected = await this.herdsmanClient.testConnection();
      if (!isConnected) {
        new Notice('无法连接到Herdsman服务，请检查服务是否运行');
        return false;
      }
    }
    
    return true;
  }
  
  /**
   * 开始处理
   */
  async startProcessing(): Promise<void> {
    // 验证条件
    if (!await this.validateBeforeProcessing()) {
      return;
    }
    
    // 确认开始
    const confirmed = confirm('开始处理字幕文件？\n\n处理过程可能需要较长时间，请确保Herdsman服务正常运行。\n\n可以在设置页面或点击丝带图标停止处理。');
    if (!confirmed) {
      return;
    }
    
    // 重置停止标志
    this.settings.shouldStop = false;
    this.settings.isProcessing = true;
    await this.saveSettings();
    
    // 更新UI状态
    this.updateUIState(true);
    
    // 开始处理
    new Notice('开始处理字幕文件，请耐心等待...');
    
    try {
      const results = await this.processor!.processAllFiles();
      
      // 显示处理结果
      this.showProcessingResults(results);
      
    } catch (error) {
      console.error('批量处理出错:', error);
      new Notice(`处理出错: ${error.message}`);
    } finally {
      // 重置处理状态
      this.settings.isProcessing = false;
      this.settings.shouldStop = false;
      await this.saveSettings();
      
      // 恢复UI状态
      this.updateUIState(false);
      
      // 清除状态栏显示
      if (this.statusBarItem) {
        this.statusBarItem.setText('拈花赛博行就绪');
        this.statusBarItem.removeClass('nianshua-processing-indicator');
      }
    }
  }
  
  /**
   * 停止处理
   */
  stopProcessing(): void {
    if (!this.settings.isProcessing) {
      new Notice('当前没有正在进行的处理任务');
      return;
    }
    
    this.settings.shouldStop = true;
    new Notice('正在停止处理，当前文件完成后将停止...');
    
    // 更新状态栏提示
    if (this.statusBarItem) {
      this.statusBarItem.setText('正在停止...');
    }
  }
  
  /**
   * 更新UI状态（处理中/空闲）
   */
  private updateUIState(isProcessing: boolean): void {
    // 更新丝带图标
    if (this.ribbonIcon) {
      if (isProcessing) {
        // 处理中显示停止图标
        this.ribbonIcon.setAttribute('aria-label', '停止处理');
      } else {
        this.ribbonIcon.setAttribute('aria-label', '开始处理');
      }
    }
    
    // 更新状态栏样式
    if (this.statusBarItem) {
      if (isProcessing) {
        this.statusBarItem.addClass('nianshua-processing-indicator');
      } else {
        this.statusBarItem.removeClass('nianshua-processing-indicator');
      }
    }
  }

  /**
   * 更新状态栏显示
   */
  private updateStatusBar(currentFile: string, current: number, total: number): void {
    if (!this.statusBarItem) return;
    
    // 截断文件名（前20个字符）
    let displayName = currentFile;
    if (currentFile.length > 20) {
      displayName = currentFile.substring(0, 20) + '...';
    }
    
    // 构建进度文本
    let progressText = '';
    
    if (this.settings.isProcessing) {
      // 文件级别进度
      if (total > 0) {
        progressText = `${displayName} (${current}/${total})`;
      } else if (currentFile) {
        progressText = `${displayName}`;
      }
      
      // 添加处理步骤
      const stepLabel = STEP_LABELS[this.currentStep];
      progressText += ` · ${stepLabel}`;
      
      // 如果有步骤信息，添加到状态栏
      if (this.currentStepInfo && this.totalChunks > 0) {
        const stepInfoText = ` [步骤${this.currentChunk}/${this.totalChunks}: ${this.currentStepInfo.resultKey}]`;
        progressText += stepInfoText;
      }
    } else {
      progressText = 'AI处理字幕功能就绪->点击开始处理';
    }
    
    this.statusBarItem.setText(progressText);
  }
  
  /**
   * 显示处理结果汇总
   */
  private showProcessingResults(results: ProcessResult[]): void {
    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;
    const totalCount = results.length;
    
    // 构建详细信息
    let details = '';
    if (failCount > 0) {
      const failedFiles = results.filter(r => !r.success).map(r => `  - ${r.fileName}: ${r.error || '未知错误'}`);
      details = '\n\n失败文件:\n' + failedFiles.join('\n');
    }
    
    // 显示弹框
    new Notice(
      `处理完成！\n` +
      `📊 总计: ${totalCount} 个文件\n` +
      `✅ 成功: ${successCount}\n` +
      `❌ 失败: ${failCount}` +
      (failCount > 0 ? `\n\n详细失败原因已记录在日志文件中` : ''),
      0 // 持续显示直到用户关闭
    );
    
    // 如果失败，显示更详细的弹框
    if (failCount > 0) {
      setTimeout(() => {
        new Notice(`失败文件详情请查看:\n${this.settings.logFolder}/log.txt`, 8000);
      }, 3000);
    }
    
    // 记录到控制台
    console.log('处理结果汇总:', {
      总计: totalCount,
      成功: successCount,
      失败: failCount,
      详情: results
    });
  }
  
  /**
   * 获取处理状态
   */
  getProcessingStatus(): ProcessingStatus {
    return {
      total: 0,
      current: 0,
      currentFile: '',
      isProcessing: this.settings.isProcessing
    };
  }
}