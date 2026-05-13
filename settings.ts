import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import { PluginSettings } from './types';
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
  
  // 处理配置
  systemPrompt: `请帮我把这个字幕内容整理成口播文案，自然分段，移除与文案无关的信息，不要有任何文案内容的删减和调整，输出文案内容部分，要与原文长度基本一致。另外要输出分段总结，关键字。输出内容要严格按照json的形式输出。格式如下
{
  "自然分段": "...",
  "分段总结": "...",
  "关键字": ["..."]
}
以下是字幕内容
{{content}}`,
  summaryPrompt: `请对以下分段总结进行整体概括，输出一个完整的内容摘要，要求简洁明了，抓住核心要点：
{{summaries}}`,
  
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
      text: '批量处理SRT字幕文件，调用Herdsman大模型进行纠错、分段、总结和关键词提取',
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
      .setDesc('存放大模型处理后的最终文件')
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

    // ========== 处理配置 ==========
    containerEl.createEl('h3', { text: '⚙️ 处理配置' });

    // 系统提示词
    new Setting(containerEl)
      .setName('字幕处理提示词')
      .setDesc('用于处理字幕内容的提示词，使用 {{content}} 作为内容占位符')
      .addTextArea(text => text
        .setPlaceholder('请输入提示词...')
        .setValue(this.plugin.settings.systemPrompt)
        .onChange(async (value) => {
          this.plugin.settings.systemPrompt = value;
          await this.plugin.saveSettings();
        })
        .then(textarea => {
          textarea.inputEl.rows = 12;
          textarea.inputEl.cols = 80;
          textarea.inputEl.style.width = '100%';
          textarea.inputEl.style.fontFamily = 'monospace';
        }));

    // 概括提示词
    new Setting(containerEl)
      .setName('整体概括提示词')
      .setDesc('用于生成整体概括的提示词，使用 {{summaries}} 作为分段总结占位符')
      .addTextArea(text => text
        .setPlaceholder('请输入提示词...')
        .setValue(this.plugin.settings.summaryPrompt)
        .onChange(async (value) => {
          this.plugin.settings.summaryPrompt = value;
          await this.plugin.saveSettings();
        })
        .then(textarea => {
          textarea.inputEl.rows = 6;
          textarea.inputEl.cols = 80;
          textarea.inputEl.style.width = '100%';
          textarea.inputEl.style.fontFamily = 'monospace';
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
}