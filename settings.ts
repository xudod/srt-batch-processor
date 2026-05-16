import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import { PluginSettings, ProcessingStepConfig } from './types';
import { HerdsmanClient } from './herdsman-client';

// 默认配置
export const DEFAULT_SETTINGS: PluginSettings = {
  // 目录配置
  baseFolder: '5T-临时文件',
  successFolder: '100-处理成功原始字幕文件',
  textOnlyFolder: '110-字幕纯文字',
  outputFolder: '120-处理后文件',
  logFolder: '130-处理日志记录',
  
  // Herdsman配置
  herdsmanUrl: 'http://localhost:8080/v1',
  modelName: '',
  
  // 多步骤大模型处理配置
  processingSteps: [
    {
      id: 'step-1',
      order: 1,
      prompt: '请帮我把这个字幕内容整理成口播文案，自然分段，移除与文案无关的信息，不要有任何文案内容的删减和调整，输出文案内容部分，要与原文长度基本一致。\n\n以下是字幕内容：\n{{content}}',
      inputSource: '{{content}}',
      resultKey: '整理后文案',
      saveToNote: true,
      savePath: '',
      outputOrder: 1
    }
  ],
  
  // 状态
  isProcessing: false,
  shouldStop: false
};

export class SubtitleProcessorSettingTab extends PluginSettingTab {
  plugin: any; // 插件实例
  herdsmanClient: HerdsmanClient | null = null;
  availableModels: string[] = [];
  isRefreshingModels: boolean = false;

  constructor(app: App, plugin: any) {
    super(app, plugin);
    this.plugin = plugin;
  }

  async display(): Promise<void> {
    const { containerEl } = this;
    containerEl.empty();

    // 初始化Herdsman客户端用于测试连接
    this.herdsmanClient = new HerdsmanClient(
      this.plugin.settings.herdsmanUrl,
      this.plugin.settings.modelName
    );

    // 标题
    containerEl.createEl('h2', { text: '拈花赛博行-字幕大模型处理设置' });
    containerEl.createEl('p', { 
      text: '批量处理SRT字幕文件，调用Herdsman大模型进行多步骤处理',
      attr: { style: 'color: var(--text-muted); margin-bottom: 20px;' }
    });

    // ========== 目录配置 ==========
    containerEl.createEl('h3', { text: '📁 目录配置' });
    
    new Setting(containerEl)
      .setName('基础文件夹')
      .setDesc('存放所有字幕文件的根目录（相对于仓库根目录）')
      .addText(text => text
        .setPlaceholder('5T-临时文件')
        .setValue(this.plugin.settings.baseFolder)
        .onChange(async (value) => {
          this.plugin.settings.baseFolder = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('成功原始字幕文件夹')
      .setDesc('第一步成功后移动原始字幕到此文件夹')
      .addText(text => text
        .setPlaceholder('100-处理成功原始字幕文件')
        .setValue(this.plugin.settings.successFolder)
        .onChange(async (value) => {
          this.plugin.settings.successFolder = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('字幕纯文字文件夹')
      .setDesc('存放提取后的纯文字内容（MD格式）')
      .addText(text => text
        .setPlaceholder('110-字幕纯文字')
        .setValue(this.plugin.settings.textOnlyFolder)
        .onChange(async (value) => {
          this.plugin.settings.textOnlyFolder = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('处理后文件文件夹')
      .setDesc('存放大模型处理后的最终文件（默认输出目录）')
      .addText(text => text
        .setPlaceholder('120-处理后文件')
        .setValue(this.plugin.settings.outputFolder)
        .onChange(async (value) => {
          this.plugin.settings.outputFolder = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('日志文件夹')
      .setDesc('存放处理日志和失败的文件')
      .addText(text => text
        .setPlaceholder('130-处理日志记录')
        .setValue(this.plugin.settings.logFolder)
        .onChange(async (value) => {
          this.plugin.settings.logFolder = value;
          await this.plugin.saveSettings();
        }));

    // 分隔线
    containerEl.createEl('hr');

    // ========== Herdsman配置 ==========
    containerEl.createEl('h3', { text: '🤖 Herdsman 配置' });

    // Herdsman服务地址
    new Setting(containerEl)
      .setName('Herdsman服务地址')
      .setDesc('本地Herdsman服务的API地址（OpenAI兼容）')
      .addText(text => text
        .setPlaceholder('http://localhost:8080/v1')
        .setValue(this.plugin.settings.herdsmanUrl)
        .onChange(async (value) => {
          this.plugin.settings.herdsmanUrl = value;
          await this.plugin.saveSettings();
          if (this.herdsmanClient) {
            this.herdsmanClient.updateConfig(
              value,
              this.plugin.settings.modelName
            );
          }
        }));

    // 测试连接按钮
    new Setting(containerEl)
      .setName('测试连接')
      .setDesc('测试是否能连接到Herdsman服务')
      .addButton(button => button
        .setButtonText('测试连接')
        .setCta()
        .onClick(async () => {
          if (this.herdsmanClient) {
            const isConnected = await this.herdsmanClient.testConnection();
            if (isConnected) {
              new Notice('✓ Herdsman连接成功');
            } else {
              new Notice('✗ Herdsman连接失败，请检查服务是否运行');
            }
          }
        }));

    // 模型选择
    new Setting(containerEl)
      .setName('模型名称')
      .setDesc('选择要使用的大模型')
      .addDropdown(async dropdown => {
        if (this.availableModels.length > 0) {
          this.availableModels.forEach(model => {
            dropdown.addOption(model, model);
          });
        } else {
          dropdown.addOption('', '点击右侧刷新按钮加载模型');
        }
        
        dropdown.setValue(this.plugin.settings.modelName || '');
        dropdown.onChange(async (value) => {
          this.plugin.settings.modelName = value;
          await this.plugin.saveSettings();
          if (this.herdsmanClient) {
            this.herdsmanClient.updateConfig(
              this.plugin.settings.herdsmanUrl,
              value
            );
          }
        });
        
        const refreshButton = document.createElement('button');
        refreshButton.textContent = '🔄 刷新模型列表';
        refreshButton.style.marginLeft = '8px';
        refreshButton.onclick = async () => {
          if (this.isRefreshingModels) return;
          
          this.isRefreshingModels = true;
          refreshButton.textContent = '加载中...';
          refreshButton.disabled = true;
          
          try {
            if (this.herdsmanClient) {
              const models = await this.herdsmanClient.listModels();
              this.availableModels = models;
              
              dropdown.selectEl.empty();
              if (models.length === 0) {
                dropdown.addOption('', '未找到模型');
              } else {
                models.forEach(model => {
                  dropdown.addOption(model, model);
                });
                if (models.includes(this.plugin.settings.modelName)) {
                  dropdown.setValue(this.plugin.settings.modelName);
                } else if (models.length > 0) {
                  dropdown.setValue(models[0]);
                  this.plugin.settings.modelName = models[0];
                  await this.plugin.saveSettings();
                }
              }
              new Notice(`找到 ${models.length} 个模型`);
            }
          } catch (error) {
            new Notice('加载模型列表失败，请检查Herdsman连接');
          } finally {
            this.isRefreshingModels = false;
            refreshButton.textContent = '🔄 刷新模型列表';
            refreshButton.disabled = false;
          }
        };
        
        dropdown.selectEl.parentElement?.appendChild(refreshButton);
      });

    // 分隔线
    containerEl.createEl('hr');

    // ========== 多步骤处理配置 ==========
    containerEl.createEl('h3', { text: '⚙️ 多步骤处理配置' });
    containerEl.createEl('p', { 
      text: '配置大模型处理流程，支持最多9个步骤，输入来源可以是原始内容{{content}}或前序步骤的处理结果{{resultKey}}',
      attr: { style: 'color: var(--text-muted); margin-bottom: 10px;' }
    });

    // 添加步骤按钮
    new Setting(containerEl)
      .setName('添加处理步骤')
      .setDesc(`当前步骤数: ${this.plugin.settings.processingSteps.length}/9`)
      .addButton(button => button
        .setButtonText('➕ 添加步骤')
        .setCta()
        .setDisabled(this.plugin.settings.processingSteps.length >= 9)
        .onClick(() => {
          this.addProcessingStep();
        }));

    // 步骤列表
    this.renderProcessingSteps(containerEl);

    // 配置校验按钮
    new Setting(containerEl)
      .setName('校验配置')
      .setDesc('检查配置是否有效（输入来源引用是否正确）')
      .addButton(button => button
        .setButtonText('🔍 校验配置')
        .onClick(() => {
          this.validateProcessingSteps();
        }));

    // 分隔线
    containerEl.createEl('hr');

    // ========== 操作按钮 ==========
    containerEl.createEl('h3', { text: '🎮 操作控制' });

    // 停止处理按钮（只显示正在处理时）
    if (this.plugin.settings.isProcessing) {
      new Setting(containerEl)
        .setName('停止处理')
        .setDesc('点击停止当前批处理任务（当前文件完成后停止）')
        .addButton(button => button
          .setButtonText('🛑 停止处理')
          .setWarning()
          .onClick(() => {
            this.plugin.stopProcessing();
            new Notice('已发送停止信号，当前文件完成后将停止');
          }));
    }

    // 重置默认设置按钮
    new Setting(containerEl)
      .setName('重置默认设置')
      .setDesc('将所有设置恢复为默认值')
      .addButton(button => button
        .setButtonText('重置')
        .setWarning()
        .onClick(async () => {
          const confirmed = confirm('确定要重置所有设置为默认值吗？此操作不可撤销。');
          if (confirmed) {
            Object.assign(this.plugin.settings, DEFAULT_SETTINGS);
            await this.plugin.saveSettings();
            this.display();
            new Notice('设置已重置为默认值');
          }
        }));
  }

  /**
   * 渲染处理步骤列表
   */
  private renderProcessingSteps(containerEl: HTMLElement): void {
    const steps = this.plugin.settings.processingSteps;
    
    if (steps.length === 0) {
      containerEl.createEl('p', { 
        text: '暂无处理步骤配置，请点击上方按钮添加',
        attr: { style: 'color: var(--text-muted); text-align: center; padding: 20px;' }
      });
      return;
    }

    // 排序步骤
    const sortedSteps = [...steps].sort((a, b) => a.order - b.order);

    sortedSteps.forEach((step, index) => {
      const stepContainer = containerEl.createDiv();
      stepContainer.style.border = '1px solid var(--background-modifier-border)';
      stepContainer.style.borderRadius = '8px';
      stepContainer.style.padding = '15px';
      stepContainer.style.marginBottom = '10px';
      stepContainer.style.background = 'var(--background-secondary)';

      // 步骤标题栏
      const headerRow = stepContainer.createDiv();
      headerRow.style.display = 'flex';
      headerRow.style.justifyContent = 'space-between';
      headerRow.style.alignItems = 'center';
      headerRow.style.marginBottom = '12px';

      headerRow.createEl('span', { 
        text: `步骤 ${step.order}`,
        attr: { style: 'font-weight: bold; color: var(--text-accent);' }
      });

      // 删除按钮
      const deleteButton = headerRow.createEl('button');
      deleteButton.textContent = '🗑️ 删除';
      deleteButton.style.padding = '4px 12px';
      deleteButton.style.border = 'none';
      deleteButton.style.borderRadius = '4px';
      deleteButton.style.background = 'var(--background-modifier-error)';
      deleteButton.style.color = 'white';
      deleteButton.style.cursor = 'pointer';
      deleteButton.style.fontSize = '12px';
      deleteButton.onclick = () => {
        this.deleteProcessingStep(step.id);
      };

      // 输入来源
      const availableInputs = this.getAvailableInputSources(step.order);
      new Setting(stepContainer)
        .setName('输入来源')
        .setDesc('选择当前步骤的输入内容')
        .addDropdown(dropdown => {
          availableInputs.forEach(input => {
            dropdown.addOption(input.value, input.label);
          });
          dropdown.setValue(step.inputSource);
          dropdown.onChange(async (value) => {
            step.inputSource = value;
            await this.plugin.saveSettings();
          });
        });

      // 结果关键字
      new Setting(stepContainer)
        .setName('结果关键字')
        .setDesc('为当前步骤的处理结果命名，后续步骤可通过{{关键字}}引用')
        .addText(text => text
          .setPlaceholder('例如：整理后文案')
          .setValue(step.resultKey)
          .onChange(async (value) => {
            step.resultKey = value;
            await this.plugin.saveSettings();
          }));

      // 提示词
      new Setting(stepContainer)
        .setName('提示词')
        .setDesc('使用 {{input}} 作为输入内容的占位符')
        .addTextArea(text => text
          .setPlaceholder('请输入提示词...')
          .setValue(step.prompt)
          .onChange(async (value) => {
            step.prompt = value;
            await this.plugin.saveSettings();
          })
          .then(textarea => {
            textarea.inputEl.rows = 6;
            textarea.inputEl.cols = 80;
            textarea.inputEl.style.width = '100%';
            textarea.inputEl.style.fontFamily = 'monospace';
          }));

      // 是否保存至笔记
      new Setting(stepContainer)
        .setName('保存至笔记')
        .setDesc('是否将当前步骤的结果保存到笔记文件')
        .addToggle(toggle => toggle
          .setValue(step.saveToNote)
          .onChange(async (value) => {
            step.saveToNote = value;
            await this.plugin.saveSettings();
            // 重新渲染以显示/隐藏保存路径输入
            this.display();
          }));

      // 保存路径（仅当保存至笔记开启时显示）
      if (step.saveToNote) {
        new Setting(stepContainer)
          .setName('保存路径')
          .setDesc('留空则使用默认处理后文件目录，支持绝对路径和相对路径')
          .addText(text => text
            .setPlaceholder('例如：120-处理后文件/整理')
            .setValue(step.savePath)
            .onChange(async (value) => {
              step.savePath = value;
              await this.plugin.saveSettings();
            }));
      }

      // 输出顺序
      new Setting(stepContainer)
        .setName('输出顺序')
        .setDesc('最终所有配置的处理结果按此顺序写入笔记')
        .addText(text => text
          .setPlaceholder('数字')
          .setValue(String(step.outputOrder))
          .onChange(async (value) => {
            step.outputOrder = parseInt(value) || 1;
            await this.plugin.saveSettings();
          }));

      // 上移/下移按钮
      const moveButtons = stepContainer.createDiv();
      moveButtons.style.display = 'flex';
      moveButtons.style.gap = '8px';
      moveButtons.style.marginTop = '10px';

      const moveUpBtn = moveButtons.createEl('button');
      moveUpBtn.textContent = '⬆️ 上移';
      moveUpBtn.style.padding = '4px 12px';
      moveUpBtn.style.border = 'none';
      moveUpBtn.style.borderRadius = '4px';
      moveUpBtn.style.background = 'var(--background-modifier-hover)';
      moveUpBtn.style.color = 'var(--text-normal)';
      moveUpBtn.style.cursor = 'pointer';
      moveUpBtn.style.fontSize = '12px';
      moveUpBtn.disabled = index === 0;
      moveUpBtn.onclick = () => {
        this.moveStepUp(index);
      };

      const moveDownBtn = moveButtons.createEl('button');
      moveDownBtn.textContent = '⬇️ 下移';
      moveDownBtn.style.padding = '4px 12px';
      moveDownBtn.style.border = 'none';
      moveDownBtn.style.borderRadius = '4px';
      moveDownBtn.style.background = 'var(--background-modifier-hover)';
      moveDownBtn.style.color = 'var(--text-normal)';
      moveDownBtn.style.cursor = 'pointer';
      moveDownBtn.style.fontSize = '12px';
      moveDownBtn.disabled = index === sortedSteps.length - 1;
      moveDownBtn.onclick = () => {
        this.moveStepDown(index);
      };
    });
  }

  /**
   * 获取可用的输入来源
   */
  private getAvailableInputSources(currentOrder: number): Array<{ label: string; value: string }> {
    const sources: Array<{ label: string; value: string }> = [
      { label: '原始字幕内容', value: '{{content}}' }
    ];

    // 获取当前步骤之前的所有步骤的结果关键字
    const previousSteps = this.plugin.settings.processingSteps
      .filter((step: ProcessingStepConfig) => step.order < currentOrder && step.resultKey);

    previousSteps.forEach((step: ProcessingStepConfig) => {
      sources.push({
        label: `步骤${step.order}结果: ${step.resultKey}`,
        value: `{{${step.resultKey}}}`
      });
    });

    return sources;
  }

  /**
   * 添加新的处理步骤
   */
  private async addProcessingStep(): Promise<void> {
    const steps = this.plugin.settings.processingSteps;
    const newOrder = steps.length + 1;
    
    const newStep: ProcessingStepConfig = {
      id: `step-${Date.now()}`,
      order: newOrder,
      prompt: '请处理以下内容：\n{{input}}',
      inputSource: '{{content}}',
      resultKey: `步骤${newOrder}结果`,
      saveToNote: false,
      savePath: '',
      outputOrder: newOrder
    };

    steps.push(newStep);
    await this.plugin.saveSettings();
    this.display();
    new Notice(`已添加步骤 ${newOrder}`);
  }

  /**
   * 删除处理步骤
   */
  private async deleteProcessingStep(stepId: string): Promise<void> {
    const steps = this.plugin.settings.processingSteps;
    const stepIndex = steps.findIndex((s: ProcessingStepConfig) => s.id === stepId);
    
    if (stepIndex === -1) return;
    
    const step = steps[stepIndex];
    const confirmed = confirm(`确定要删除步骤 ${step.order} 吗？`);
    
    if (confirmed) {
      steps.splice(stepIndex, 1);
      // 重新编号
      steps.forEach((s: ProcessingStepConfig, i: number) => {
        s.order = i + 1;
      });
      await this.plugin.saveSettings();
      this.display();
      new Notice('步骤已删除');
    }
  }

  /**
   * 上移步骤
   */
  private async moveStepUp(index: number): Promise<void> {
    const steps = this.plugin.settings.processingSteps;
    if (index <= 0) return;

    const temp = steps[index];
    steps[index] = steps[index - 1];
    steps[index - 1] = temp;

    // 重新编号
    steps.forEach((s: ProcessingStepConfig, i: number) => {
      s.order = i + 1;
    });

    await this.plugin.saveSettings();
    this.display();
  }

  /**
   * 下移步骤
   */
  private async moveStepDown(index: number): Promise<void> {
    const steps = this.plugin.settings.processingSteps;
    if (index >= steps.length - 1) return;

    const temp = steps[index];
    steps[index] = steps[index + 1];
    steps[index + 1] = temp;

    // 重新编号
    steps.forEach((s: ProcessingStepConfig, i: number) => {
      s.order = i + 1;
    });

    await this.plugin.saveSettings();
    this.display();
  }

  /**
   * 校验处理步骤配置
   */
  private validateProcessingSteps(): void {
    const steps = this.plugin.settings.processingSteps;
    const errors: string[] = [];

    // 检查至少有一个步骤
    if (steps.length === 0) {
      errors.push('❌ 至少需要配置一个处理步骤');
    }

    // 检查不超过9个步骤
    if (steps.length > 9) {
      errors.push('❌ 处理步骤不能超过9个');
    }

    // 检查输入来源引用是否正确
    for (const step of steps) {
      // 检查输入来源是否为{{content}}或有效的前序步骤引用
      if (step.inputSource !== '{{content}}') {
        // 提取引用的关键字（支持中文）
        const match = step.inputSource.match(/\{\{(.+?)\}\}/);
        if (match) {
          const referencedKey = match[1];
          // 检查是否有前序步骤使用这个关键字
          const hasPreviousStep = steps.some(
            (s: ProcessingStepConfig) => s.order < step.order && s.resultKey === referencedKey
          );
          if (!hasPreviousStep) {
            errors.push(`❌ 步骤${step.order}的输入来源引用了不存在的关键字 "${referencedKey}"`);
          }
        } else {
          errors.push(`❌ 步骤${step.order}的输入来源格式不正确`);
        }
      }
    }

    // 检查结果关键字是否重复
    const keys = steps.map((s: ProcessingStepConfig) => s.resultKey);
    const uniqueKeys = new Set(keys);
    if (keys.length !== uniqueKeys.size) {
      errors.push('❌ 存在重复的结果关键字');
    }

    // 显示结果
    if (errors.length === 0) {
      new Notice('✅ 配置校验通过！');
    } else {
      const errorMessage = errors.join('\n');
      new Notice(errorMessage, 10000);
      console.error('配置校验失败:', errors);
    }
  }
}
