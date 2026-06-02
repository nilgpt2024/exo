/**
 * Transform a single message's content into HTML, preserving <think> blocks.
 */
function renderKaTeX(html) {
  // 渲染块级公式 $$...$$
  html = html.replace(/\$\$([\s\S]+?)\$\$/g, (match, formula) => {
    try {
      const rendered = katex.renderToString(formula.trim(), {
        displayMode: true,
        throwOnError: false
      });
      return `<div class="katex-block">${rendered}</div>`;
    } catch (e) {
      return match;
    }
  });

  // 渲染行内公式 $...$
  html = html.replace(/\$([^\$\n]+?)\$/g, (match, formula) => {
    try {
      const rendered = katex.renderToString(formula.trim(), {
        displayMode: false,
        throwOnError: false
      });
      return `<span class="katex-inline">${rendered}</span>`;
    } catch (e) {
      return match;
    }
  });

  return html;
}

function transformMessageContent(message) {
  let text = message.content || '';

  if (!text.trim()) return '';

  // 处理 <think> 块
  text = text.replace(
    /<think([\s\S]*?)(?:<\/think>|$)/g,
    (match, body) => {
      const isComplete = match.includes('</think');
      const spinnerClass = isComplete ? '' : ' thinking';
      const parsedBody = DOMPurify.sanitize(marked.parse(body), {
        ALLOWED_TAGS: ['h1','h2','h3','h4','h5','h6','p','br','hr','strong','em','b','i','code','pre','ul','ol','li','blockquote','table','thead','tbody','tr','th','td','a','span','div'],
        ALLOWED_ATTR: ['href','class','id','style','target','rel']
      });
      return `<div class='thinking-block'><div class='thinking-header${spinnerClass}'>Thinking...</div><div class='thinking-content'>${parsedBody}</div></div>`;
    }
  );

  try {
    const markedOutput = marked.parse(text);
    let htmlWithMath = renderKaTeX(markedOutput);
    const sanitizedOutput = DOMPurify.sanitize(htmlWithMath, {
      ALLOWED_TAGS: [
        'h1','h2','h3','h4','h5','h6',
        'p','br','hr',
        'strong','em','b','i','u','s','del','ins','sub','sup','mark','small',
        'ul','ol','li','dl','dt','dd',
        'blockquote','pre','code','kbd','samp','var',
        'table','thead','tbody','tfoot','tr','th','td','caption','colgroup','col',
        'a','img','figure','figcaption','picture','source',
        'details','summary','abbr',
        'span','div','section','article','aside','header','footer','main','nav',
        'ruby','rt','rp','rtc','rb','wbr',
        'math','mi','mo','mn','ms','mtext','mspace','mrow','mfrac','msqrt','mroot','mfenced','msup','msub','msubsup','mover','munder','munderover','mtable','mtr','mtd','mlabeledtr','mtd','mlongdiv','msgroup','msline','mspace','semantics','annotation','annotation-xml',
        'audio','source'
      ],
      ALLOWED_ATTR: [
        'href','title','alt','src','width','height','loading','decoding',
        'class','id','style','lang','dir','translate','spellcheck',
        'target','rel','download','hreflang','type','media',
        'colspan','rowspan','headers','scope','align','valign',
        'start','type','reversed','value',
        'open','cite','datetime',
        'controls','preload','autoplay','loop','muted',
        'data-*','aria-*','role',
        'display','mathbackground','mathcolor','mathvariant','mathsize','mathfamily','mathweight','mathshape','mathstretchy','mathfences','mathspace','movablelimits','stretchy','fence','separator','accent','accentunder','largeop','lspace','rspace','minsize','maxsize','symmetric','dir','side','voffset','hoffset','width','height','linebreak','linebreakstyle','linebreakmultchar','linebreakindentshift','linebreakindent','linebreakmaxwidth','linebreakminleading','linebreakstyle'
      ],
      ADD_ATTR: ['target'],
      FORCE_BODY: true
    });
    return sanitizedOutput;
  } catch (e) {
    console.error('Markdown render error:', e);
    return text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}

document.addEventListener("alpine:init", () => {
  Alpine.data("state", () => ({
    // 多标签页支持
    // tabs: [{ id, modelId, messages, time, title }]
    tabs: JSON.parse(localStorage.getItem("tabs")) || [],
    activeTabId: null,

    // 当前标签页状态
    get cstate() {
      const tab = this.tabs.find(t => t.id === this.activeTabId);
      return tab || { time: null, messages: [], modelId: 'llama-3.2-1b' };
    },

    // 当前模型 ID
    get modelId() {
      return this.cstate.modelId || 'llama-3.2-1b';
    },

    // 历史记录 - 按模型分组存储
    // 格式: { "model-name": [ {time, messages, modelId}, ... ], ... }
    allHistories: JSON.parse(localStorage.getItem("allHistories")) || {},

    // 当前模型的历史记录
    get histories() {
      return this.allHistories[this.modelId] || [];
    },

    // 保存标签页到 localStorage
    saveTabs() {
      localStorage.setItem("tabs", JSON.stringify(this.tabs));
    },

    // 保存历史记录
    saveHistories(newHistories) {
      const currentModelId = this.modelId;
      this.allHistories[currentModelId] = newHistories;
      localStorage.setItem("allHistories", JSON.stringify(this.allHistories));
    },

    // 创建新标签页
    createTab(modelId = null) {
      const id = Date.now().toString();
      const selectedModel = modelId || this.modelId || 'llama-3.2-1b';
      const tab = {
        id,
        modelId: selectedModel,
        messages: [],
        time: null,
        title: this.models[selectedModel]?.name || selectedModel
      };
      this.tabs.push(tab);
      this.activeTabId = id;
      this.saveTabs();
      return tab;
    },

    // 关闭标签页
    closeTab(tabId) {
      const index = this.tabs.findIndex(t => t.id === tabId);
      if (index !== -1) {
        const tab = this.tabs[index];
        
        // 从 allHistories 中删除该 tab 对应的历史记录
        if (tab && tab.time && tab.modelId) {
          const modelHistories = this.allHistories[tab.modelId] || [];
          const historyIndex = modelHistories.findIndex(h => h.time === tab.time);
          if (historyIndex !== -1) {
            modelHistories.splice(historyIndex, 1);
            this.allHistories[tab.modelId] = modelHistories;
            localStorage.setItem("allHistories", JSON.stringify(this.allHistories));
          }
        }
        
        this.tabs.splice(index, 1);
        if (this.activeTabId === tabId) {
          this.activeTabId = this.tabs.length > 0 ? this.tabs[Math.max(0, index - 1)].id : null;
        }
        this.saveTabs();
      }
    },

    // 切换标签页
    switchTab(tabId) {
      this.activeTabId = tabId;
      this.saveTabs();
    },

    // 更新当前标签页
    updateCurrentTab(updates) {
      const tab = this.tabs.find(t => t.id === this.activeTabId);
      if (tab) {
        Object.assign(tab, updates);
        this.saveTabs();
      }
    },

    // 渲染单个消息
    renderMessage(msg, tabId, index) {
      const div = document.createElement('div');
      div.className = 'message message-role-' + msg.role;
      div.id = 'msg-' + tabId + '-' + index;
      
      try {
        if (msg.content.includes('![Generated Image]') || msg.content.includes('![Uploaded Image]')) {
          const imageUrlMatch = msg.content.match(/\((.*?)\)/);
          if (imageUrlMatch) {
            const imageUrl = imageUrlMatch[1];
            const img = document.createElement('img');
            img.src = imageUrl;
            img.alt = msg.content.includes('![Generated Image]') ? '生成的图片' : '上传的图片';
            img.className = 'chat-image';
            img.onclick = async () => {
              try {
                const response = await fetch(img.src);
                const blob = await response.blob();
                const file = new File([blob], 'image.png', { type: 'image/png' });
                this.handleImageUpload({ target: { files: [file] } });
              } catch (error) {
                console.error('Error fetching image:', error);
              }
            };
            div.appendChild(img);
            const textContent = msg.content.replace(/!\[.*?\]\(.*?\)/, '').trim();
            if (textContent) {
              const textDiv = document.createElement('div');
              textDiv.innerHTML = transformMessageContent({...msg, content: textContent});
              div.appendChild(textDiv);
            }
          } else {
            div.textContent = msg.content;
          }
        } else {
          if (typeof transformMessageContent === 'function') {
            try {
              const html = transformMessageContent(msg);
              div.innerHTML = html;
            } catch (e) {
              console.error('Error in transformMessageContent:', e);
              div.textContent = msg.content;
            }
          } else {
            console.error('transformMessageContent is not available');
            div.textContent = msg.content;
          }
        }
      } catch (e) {
        console.error('Error rendering message:', e);
        div.textContent = msg.content;
      }
      
      div.querySelectorAll('pre').forEach((pre) => {
        const button = document.createElement('button');
        button.className = 'clipboard-button';
        button.innerHTML = '<i class="fas fa-clipboard"></i>';
        button.onclick = () => {
          navigator.clipboard.writeText(pre.textContent);
          button.innerHTML = '<i class="fas fa-check"></i>';
          setTimeout(() => button.innerHTML = '<i class="fas fa-clipboard"></i>', 1000);
        };
        pre.appendChild(button);
      });
      
      return div;
    },

    // 初始化消息容器
    initMessagesContainer(el, tabId) {
      let previousMessagesLength = 0;
      let lastMessageContent = '';
      
      const renderMessages = () => {
        const tab = this.tabs.find(t => t.id === tabId);
        if (!tab) return;
        
        const currentLength = tab.messages.length;
        
        if (currentLength < previousMessagesLength) {
          el.innerHTML = '';
          previousMessagesLength = 0;
          lastMessageContent = '';
        }
        
        // 处理新增的消息
        if (currentLength > previousMessagesLength) {
          for (let i = previousMessagesLength; i < currentLength; i++) {
            const msg = tab.messages[i];
            const msgDiv = this.renderMessage(msg, tabId, i);
            el.appendChild(msgDiv);
          }
          previousMessagesLength = currentLength;
          if (currentLength > 0) {
            lastMessageContent = tab.messages[currentLength - 1].content;
          }
          
          this.$nextTick(() => {
            el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
          });
        }
        // 处理最后一条消息的更新（流式生成）
        else if (currentLength === previousMessagesLength && currentLength > 0) {
          const lastMsg = tab.messages[currentLength - 1];
          if (lastMsg.content !== lastMessageContent) {
            // 更新最后一条消息的 DOM
            const lastMsgDiv = el.querySelector(`#msg-${tabId}-${currentLength - 1}`);
            if (lastMsgDiv) {
              const newMsgDiv = this.renderMessage(lastMsg, tabId, currentLength - 1);
              lastMsgDiv.replaceWith(newMsgDiv);
              lastMessageContent = lastMsg.content;
              
              this.$nextTick(() => {
                el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
              });
            }
          }
        }
      };
      
      this.$watch('tabs', renderMessages, { deep: true });
      renderMessages();
    },

    home: 0,
    generatingTabs: {},  // 按 tabId 跟踪每个 tab 的生成状态
    currentAbortController: null,  // 用于取消当前请求
    endpoint: `${window.location.origin}/v1`,

    // 检查指定 tab 是否在生成中
    isGenerating(tabId) {
      return this.generatingTabs[tabId] || false;
    },

    // 设置指定 tab 的生成状态
    setGenerating(tabId, value) {
      this.generatingTabs[tabId] = value;
    },

    // Initialize error message structure
    errorMessage: null,
    errorExpanded: false,
    errorTimeout: null,

    // performance tracking
    time_till_first: 0,
    tokens_per_second: 0,
    total_tokens: 0,

    // image handling
    imagePreview: null,

    // TTS settings
    ttsSettings: {
      mode: "voice_design",
      language: "Chinese",
      instruct: "",
      speaker: ""
    },

    // download progress
    downloadProgress: null,
    downloadProgressInterval: null, // To keep track of the polling interval

    // Pending message storage
    pendingMessage: null,

    modelPoolInterval: null,

    // Add models state alongside existing state
    models: {},

    // Show only models available locally
    showDownloadedOnly: false,

    topology: null,
    topologyInterval: null,

    // Settings panel state
    showSettingsPanel: false,
    showApiKey: false,
    apiKey: localStorage.getItem("apiKey") || "",

    // Discovery module state
    discoveryStatus: null,
    selectedDiscoveryType: 'udp',
    switchingDiscovery: false,
    frpConfig: {
      server_addr: '',
      server_port: 7000,
      token: '',
      remote_port: null,
      seed_peers: '',
      enable_p2p: false
    },
    udpConfig: {
      listen_port: 5678,
      broadcast_port: 5678
    },
    tailscaleConfig: {
      api_key: '',
      tailnet_name: ''
    },
    manualConfig: {
      config_path: ''
    },

    // Add these new properties
    expandedGroups: {},

    init() {
      // Clean up any pending messages
      localStorage.removeItem("pendingMessage");

      // 如果没有标签页，创建一个默认标签页
      if (this.tabs.length === 0) {
        this.createTab('llama-3.2-1b');
      } else {
        // 恢复上次活动的标签页
        this.activeTabId = this.tabs[0].id;
      }

      // Get initial model list
      this.fetchInitialModels();

      // Start polling for download progress
      this.startDownloadProgressPolling();

      // Start model polling with the new pattern
      this.startModelPolling();

      // Fetch discovery status
      this.fetchDiscoveryStatus();

      // Watch for apiKey changes and save to localStorage
      this.$watch('apiKey', (value) => {
        if (value) {
          localStorage.setItem('apiKey', value);
        } else {
          localStorage.removeItem('apiKey');
        }
      });
    },

    async fetchInitialModels() {
      try {
        const response = await fetch(`${window.location.origin}/initial_models`);
        if (response.ok) {
          const initialModels = await response.json();
          this.models = initialModels;
        }
      } catch (error) {
        console.error('获取初始模型失败:', error);
      }
    },

    async startModelPolling() {
      while (true) {
        try {
          await this.populateSelector();
          // Wait 15 seconds before next poll
          await new Promise(resolve => setTimeout(resolve, 15000));
        } catch (error) {
          console.error('模型轮询错误:', error);
          // 如果出错，等待后重试
          await new Promise(resolve => setTimeout(resolve, 15000));
        }
      }
    },

    async populateSelector() {
      return new Promise((resolve, reject) => {
        const evtSource = new EventSource(`${window.location.origin}/modelpool`);

        evtSource.onmessage = (event) => {
          if (event.data === "[DONE]") {
            evtSource.close();
            resolve();
            return;
          }

          const modelData = JSON.parse(event.data);
          // Update existing model data while preserving other properties
          Object.entries(modelData).forEach(([modelName, data]) => {
            if (this.models[modelName]) {
              this.models[modelName] = {
                ...this.models[modelName],
                ...data,
                loading: false
              };
            }
          });
        };

        evtSource.onerror = (error) => {
          console.error('EventSource failed:', error);
          evtSource.close();
          reject(error);
        };
      });
    },

    removeHistory(cstate) {
      const currentHistories = this.histories;
      const index = currentHistories.findIndex((state) => {
        return state.time === cstate.time;
      });
      if (index !== -1) {
        currentHistories.splice(index, 1);
        this.saveHistories(currentHistories);
      }
    },

    clearAllHistory() {
      this.saveHistories([]);
    },

    // Utility functions
    formatBytes(bytes) {
      if (bytes === 0) return '0 B';
      const k = 1024;
      const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    },

    formatDuration(seconds) {
      if (seconds === null || seconds === undefined || isNaN(seconds)) return '';
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      const s = Math.floor(seconds % 60);
      if (h > 0) return `${h}h ${m}m ${s}s`;
      if (m > 0) return `${m}m ${s}s`;
      return `${s}s`;
    },

    async handleImageUpload(event) {
      const file = event.target.files[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = (e) => {
          this.imagePreview = e.target.result;
          this.imageUrl = e.target.result; // Store the image URL
          // 不立即添加消息，而是在发送时统一处理
        };
        reader.readAsDataURL(file);
      }
    },


    async handleSend(event, tabId) {
      try {
        // 获取 textarea 元素 - 优先使用 ID 查找
        const el = document.getElementById(`input-form-${tabId}`);
        if (!el) {
          console.error('找不到 textarea 元素，tabId:', tabId);
          return;
        }
        const value = el.value.trim();
        if (!value && !this.imagePreview) return;

        // 如果正在生成，取消之前的请求
        if (this.isGenerating(tabId)) {
          this.cancelCurrentRequest();
        }
        
        this.setGenerating(tabId, true);
        this.activeTabId = tabId;

        // 获取当前标签页
        const tab = this.tabs.find(t => t.id === tabId);
        if (!tab) return;
        
        const currentMessages = [...tab.messages];
        
        // add message to list (统一处理图片和文字)
        if (this.imagePreview && value) {
          // 既有图片又有文字
          currentMessages.push({
            role: "user",
            content: `![Uploaded Image](${this.imagePreview})\n${value}`
          });
        } else if (this.imagePreview) {
          // 只有图片
          currentMessages.push({
            role: "user",
            content: `![Uploaded Image](${this.imagePreview})`
          });
        } else if (value) {
          // 只有文字
          currentMessages.push({ role: "user", content: value });
        }
        
        // 更新标签页的消息
        tab.messages = currentMessages;
        this.saveTabs();

        // clear textarea
        el.value = "";
        el.style.height = "auto";
        el.style.height = el.scrollHeight + "px";

        localStorage.setItem("pendingMessage", value);
        this.processMessage(value, tabId);
      } catch (error) {
        console.error('error', error);
        this.setError(error);
        this.setGenerating(tabId, false);
      }
    },

    async handleEnter(event, tabId) {
      // if shift is not pressed
      if (!event.shiftKey) {
        event.preventDefault();
        await this.handleSend(event, tabId);
      }
    },

    async processMessage(value, tabId) {
      try {
        // reset performance tracking
        const prefill_start = Date.now();
        let start_time = 0;
        let tokens = 0;
        this.tokens_per_second = 0;

        // 获取当前标签页
        const tab = this.tabs.find(t => t.id === tabId);
        if (!tab) return;

        // 使用本地变量跟踪消息变化
        let localMessages = [...tab.messages];
        
        console.log('[DEBUG] tab.messages:', JSON.stringify(tab.messages));
        console.log('[DEBUG] localMessages:', JSON.stringify(localMessages));

        // prepare messages for API request
        let apiMessages = localMessages.map(msg => {
          if (msg.content.startsWith('![Uploaded Image]')) {
            // 解析图片和文字
            const lines = msg.content.split('\n');
            const imageLine = lines[0];
            const textContent = lines.slice(1).join('\n').trim();
            
            // 从 markdown 格式中提取图片 URL
            const imageUrlMatch = imageLine.match(/!\[Uploaded Image\]\((.+?)\)/);
            const imageUrl = imageUrlMatch ? imageUrlMatch[1] : this.imageUrl;
            
            const content = [
              {
                type: "image_url",
                image_url: {
                  url: imageUrl
                }
              }
            ];
            
            // 如果有文字，添加到 content
            if (textContent) {
              content.push({
                type: "text",
                text: textContent
              });
            }
            
            return {
              role: "user",
              content: content
            };
          } else {
            return {
              role: msg.role,
              content: msg.content
            };
          }
        });
        
        const currentModelId = tab.modelId;
        
        if (currentModelId && currentModelId.startsWith('qwen-3-tts')) {
          localMessages.push({ role: "assistant", content: "⏳ 正在生成语音..." });
          tab.messages = [...localMessages];
          this.saveTabs();

          const ttsSettings = this.ttsSettings || {};
          const response = await fetch(`${this.endpoint}/audio/generations`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: currentModelId,
              text: value,
              mode: ttsSettings.mode || "voice_design",
              language: ttsSettings.language || "Chinese",
              instruct: ttsSettings.instruct || "",
              speaker: ttsSettings.speaker || ""
            }),
          });

          if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            throw new Error(errData.detail || "生成语音失败");
          }

          const audioBlob = await response.blob();
          const audioUrl = URL.createObjectURL(audioBlob);
          localMessages[localMessages.length - 1].content = `<audio controls src="${audioUrl}" style="max-width:100%;"></audio>`;
          tab.messages = [...localMessages];
          this.saveTabs();
        }

        else if (currentModelId === "stable-diffusion-2-1-base") {
          // Send a request to the image generation endpoint
          console.log(apiMessages[apiMessages.length - 1].content)
          console.log(currentModelId)  
          console.log(this.endpoint)
          const response = await fetch(`${this.endpoint}/image/generations`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              "model": 'stable-diffusion-2-1-base',
              "prompt": apiMessages[apiMessages.length - 1].content,
              "image_url": this.imageUrl
            }),
          });
      
          if (!response.ok) {
            throw new Error("获取失败");
          }
          const reader = response.body.getReader();
          let done = false;
          let gottenFirstChunk = false;
  
          while (!done) {
            const { value, done: readerDone } = await reader.read();
            done = readerDone;
            const decoder = new TextDecoder('utf-8');
  
            if (value) {
              // Assume non-binary data (text) comes first
              const chunk = decoder.decode(value, { stream: true });
              const parsed = JSON.parse(chunk);
              console.log(parsed)
  
              if (parsed.progress) {
                if (!gottenFirstChunk) {
                  localMessages.push({ role: "assistant", content: "" });
                  gottenFirstChunk = true;
                }
                localMessages[localMessages.length - 1].content = parsed.progress;
                tab.messages = [...localMessages];
                this.saveTabs();
              }
              else if (parsed.images) {
                if (!gottenFirstChunk) {
                  localMessages.push({ role: "assistant", content: "" });
                  gottenFirstChunk = true;
                }
                const imageUrl = parsed.images[0].url;
                console.log(imageUrl)
                localMessages[localMessages.length - 1].content = `![Generated Image](${imageUrl}?t=${Date.now()})`;
                tab.messages = [...localMessages];
                this.saveTabs();
              }
            }
          }
        }
        
        else{        
          const containsImage = apiMessages.some(msg => Array.isArray(msg.content) && msg.content.some(item => item.type === 'image_url'));
          if (containsImage) {
            // Map all messages with string content to object with type text
            apiMessages = apiMessages.map(msg => {
              if (typeof msg.content === 'string') {
                return {
                  ...msg,
                  content: [
                    {
                      type: "text",
                      text: msg.content
                    }
                  ]
                };
              }
              return msg;
            });
          }

          console.log('[DEBUG] apiMessages:', JSON.stringify(apiMessages));
          //start receiving server sent events
          let gottenFirstChunk = false;
          for await (
            const chunk of this.openaiChatCompletion(currentModelId, apiMessages)
          ) {
            if (!gottenFirstChunk) {
              // 检查最后一条消息是否是助手消息，如果是则替换，否则添加新消息
              const lastMsg = localMessages[localMessages.length - 1];
              if (lastMsg && lastMsg.role === "assistant") {
                // 如果最后一条是助手消息（可能是打断前的残留），替换它
                lastMsg.content = "";
              } else {
                // 否则添加新的助手消息
                localMessages.push({ role: "assistant", content: "" });
              }
              gottenFirstChunk = true;
            }

            // add chunk to the last message
            localMessages[localMessages.length - 1].content += chunk;
            
            // 更新标签页的消息
            tab.messages = [...localMessages];
            this.saveTabs();

            // calculate performance tracking
            tokens += 1;
            this.total_tokens += 1;
            if (start_time === 0) {
              start_time = Date.now();
              this.time_till_first = start_time - prefill_start;
            } else {
              const diff = Date.now() - start_time;
              if (diff > 0) {
                this.tokens_per_second = tokens / (diff / 1000);
              }
            }
          }
        }
        // Clean the cstate before adding it to histories
        const cleanedCstate = {
          time: tab.time,
          modelId: currentModelId,
          messages: localMessages.map(msg => {
            if (Array.isArray(msg.content)) {
              return {
                ...msg,
                content: msg.content.map(item =>
                  item.type === 'image_url' ? { type: 'image_url', image_url: { url: '[IMAGE_PLACEHOLDER]' } } : item
                )
              };
            }
            return msg;
          })
        };

        // Update the state in histories or add it if it doesn't exist
        const originalTime = cleanedCstate.time;
        const currentHistories = this.allHistories[currentModelId] || [];
        const index = currentHistories.findIndex((cstate) => cstate.time === originalTime);
        cleanedCstate.time = originalTime || Date.now();
        // 确保 modelId 被保存
        if (!cleanedCstate.modelId) {
          cleanedCstate.modelId = currentModelId;
        }
        if (index !== -1) {
          currentHistories[index] = cleanedCstate;
        } else {
          currentHistories.push(cleanedCstate);
        }
        
        // 更新标签页的时间戳
        tab.time = cleanedCstate.time;
        this.saveTabs();
        
        // update in local storage
        try {
          this.allHistories[currentModelId] = currentHistories;
          localStorage.setItem("allHistories", JSON.stringify(this.allHistories));
        } catch (error) {
          console.error("保存历史记录到本地存储失败:", error);
        }
      } catch (error) {
        // 如果是取消请求导致的错误，不显示错误信息
        if (error.name === 'AbortError' || error.message?.includes('aborted') || error.message?.includes('取消')) {
          console.log('生成被用户取消');
        } else {
          console.error('error', error);
          this.setError(error);
        }
      } finally {
        this.setGenerating(tabId, false);
        // 清除图片预览
        this.imagePreview = null;
        this.imageUrl = null;
      }
    },

    async handleEnter(event, tabId) {
      // if shift is not pressed
      if (!event.shiftKey) {
        event.preventDefault();
        await this.handleSend(event, tabId);
      }
    },

    updateTotalTokens(messages) {
      fetch(`${this.endpoint}/chat/token/encode`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages }),
      }).then((response) => response.json()).then((data) => {
        this.total_tokens = data.length;
      }).catch(console.error);
    },

    cancelCurrentRequest() {
      if (this.currentAbortController) {
        this.currentAbortController.abort();
        this.currentAbortController = null;
      }
    },

    async *openaiChatCompletion(model, messages) {
      // 创建新的 AbortController
      this.currentAbortController = new AbortController();
      const signal = this.currentAbortController.signal;
      
      let response;
      try {
        response = await fetch(`${this.endpoint}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            "model": model,
            "messages": messages,
            "stream": true,
          }),
          signal: signal,  // 传递 signal 以支持取消
        });
      } catch (error) {
        if (error.name === 'AbortError') {
          console.log('请求被取消');
          this.currentAbortController = null;
          return;
        }
        throw error;
      }
      
      if (!response.ok) {
        const errorResBody = await response.json()
        if (errorResBody?.detail) {
          throw new Error(`获取补全失败: ${errorResBody.detail}`);
        } else {
          throw new Error("获取补全失败: 未知错误");
        }
      }

      const reader = response.body.pipeThrough(new TextDecoderStream('utf-8'))
        .pipeThrough(new EventSourceParserStream()).getReader();
      
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          if (value.type === "event") {
            const json = JSON.parse(value.data);
            if (json.choices) {
              const choice = json.choices[0];
              if (choice.finish_reason === "stop") break;
              if (choice.delta.content) yield choice.delta.content;
            }
          }
        }
      } catch (error) {
        if (error.name === 'AbortError') {
          console.log('请求被取消');
          return;
        }
        throw error;
      } finally {
        this.currentAbortController = null;
      }
    },

    async fetchDownloadProgress() {
      try {
        const response = await fetch(`${this.endpoint}/download/progress`);
        if (response.ok) {
          const data = await response.json();
          const progressArray = Object.values(data);
          if (progressArray.length > 0) {
            this.downloadProgress = progressArray.map(progress => {
              // Check if download is complete
              if (progress.status === "complete") {
                return {
                  ...progress,
                  isComplete: true,
                  percentage: 100
                };
              } else if (progress.status === "failed") {
                return {
                  ...progress,
                  isComplete: false,
                  errorMessage: "下载失败"
                };
              } else {
                return {
                  ...progress,
                  isComplete: false,
                  downloaded_bytes_display: this.formatBytes(progress.downloaded_bytes),
                  total_bytes_display: this.formatBytes(progress.total_bytes),
                  overall_speed_display: progress.overall_speed ? this.formatBytes(progress.overall_speed) + '/s' : '',
                  overall_eta_display: progress.overall_eta ? this.formatDuration(progress.overall_eta) : '',
                  percentage: ((progress.downloaded_bytes / progress.total_bytes) * 100).toFixed(2)
                };
              }
            });
            const allComplete = this.downloadProgress.every(progress => progress.isComplete);
            if (allComplete) {
              // Check for pendingMessage
              const savedMessage = localStorage.getItem("pendingMessage");
              if (savedMessage) {
                // Clear pendingMessage
                localStorage.removeItem("pendingMessage");
                // Call processMessage() with savedMessage
                if (this.lastErrorMessage) {
                  await this.processMessage(savedMessage);
                }
              }
              this.lastErrorMessage = null;
              this.downloadProgress = null;
            }
          } else {
            // No ongoing download
            this.downloadProgress = null;
          }
        }
      } catch (error) {
        console.error("获取下载进度失败:", error);
        this.downloadProgress = null;
      }
    },

    startDownloadProgressPolling() {
      if (this.downloadProgressInterval) {
        // Already polling
        return;
      }
      this.fetchDownloadProgress(); // Fetch immediately
      this.downloadProgressInterval = setInterval(() => {
        this.fetchDownloadProgress();
      }, 1000); // Poll every second
    },

    // 添加一个辅助方法来统一设置错误
    setError(error) {
      this.errorMessage = {
        basic: error.message || "发生未知错误",
        stack: error.stack || ""
      };
      this.errorExpanded = false;

      if (this.errorTimeout) {
        clearTimeout(this.errorTimeout);
      }

      if (!this.errorExpanded) {
        this.errorTimeout = setTimeout(() => {
          this.errorMessage = null;
          this.errorExpanded = false;
        }, 30 * 1000);
      }
    },

    async deleteModel(modelName, model) {
      const downloadedSize = model.total_downloaded || 0;
      const sizeMessage = downloadedSize > 0 ?
        `This will free up ${this.formatBytes(downloadedSize)} of space.` :
        'This will remove any partially downloaded files.';

      if (!confirm(`Are you sure you want to delete ${model.name}? ${sizeMessage}`)) {
        return;
      }

      try {
        const response = await fetch(`${window.location.origin}/models/${modelName}`, {
          method: 'DELETE',
          headers: {
            'Content-Type': 'application/json'
          }
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.detail || '删除模型失败');
        }

        // Update the model status in the UI
        if (this.models[modelName]) {
          this.models[modelName].downloaded = false;
          this.models[modelName].download_percentage = 0;
          this.models[modelName].total_downloaded = 0;
        }

        // If this was the selected model, close tabs using this model
        this.tabs = this.tabs.filter(tab => tab.modelId !== modelName);
        if (this.tabs.length === 0) {
          this.createTab('llama-3.2-1b');
        }
        this.saveTabs();

        // 显示成功消息
        console.log(`模型已成功从 ${data.path} 删除`);

        // 刷新模型列表
        await this.populateSelector();
      } catch (error) {
        console.error('删除模型失败:', error);
        this.setError(error.message || '删除模型失败');
      }
    },

    async unloadModel(modelName, model) {
      if (!confirm(`确定要从内存中卸载 ${model.name} 吗？\n这将释放内存空间，但不会删除模型文件。`)) {
        return;
      }

      try {
        const response = await fetch(`${window.location.origin}/models/${modelName}/unload`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          }
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.detail || '卸载模型失败');
        }

        // 更新模型状态
        if (this.models[modelName]) {
          this.models[modelName].loaded_in_memory = false;
        }

        console.log(`模型 ${modelName} 已从内存卸载`);

        // 刷新模型列表
        await this.populateSelector();
      } catch (error) {
        console.error('卸载模型失败:', error);
        this.setError(error.message || '卸载模型失败');
      }
    },

    async handleDownload(modelName) {
      try {
        const response = await fetch(`${window.location.origin}/download`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: modelName
          })
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || '开始下载失败');
        }

        // 下载开始时立即更新模型状态
        if (this.models[modelName]) {
          this.models[modelName] = {
            ...this.models[modelName],
            loading: true
          };
        }

      } catch (error) {
        console.error('开始下载失败:', error);
        this.setError(error);
      }
    },

    async fetchTopology() {
      try {
        const response = await fetch(`${this.endpoint}/topology`);
        if (!response.ok) throw new Error('获取拓扑失败');
        return await response.json();
      } catch (error) {
        console.error('获取拓扑失败:', error);
        return null;
      }
    },

    async fetchDiscoveryStatus() {
      try {
        const response = await fetch(`${this.endpoint}/discovery/status`);
        if (response.ok) {
          this.discoveryStatus = await response.json();
          // Set the selected type based on current discovery
          if (this.discoveryStatus.discovery_type) {
            const typeMap = {
              'FRPDiscovery': 'frp',
              'UDPDiscovery': 'udp',
              'TailscaleDiscovery': 'tailscale',
              'ManualDiscovery': 'manual'
            };
            this.selectedDiscoveryType = typeMap[this.discoveryStatus.discovery_type] || 'udp';
          }
        }
      } catch (error) {
        console.error('获取发现模块状态失败:', error);
      }
    },

    copyToClipboard(text, evt) {
      navigator.clipboard.writeText(text).then(() => {
        if (evt && evt.target) {
          const btn = evt.target.closest('.copy-btn');
          if (btn) {
            const originalHtml = btn.innerHTML;
            btn.innerHTML = '<i class="fas fa-check"></i>';
            setTimeout(() => {
              btn.innerHTML = originalHtml;
            }, 1500);
          }
        }
      }).catch(err => {
        console.error('复制失败:', err);
      });
    },

    saveApiKey() {
      if (this.apiKey) {
        localStorage.setItem('apiKey', this.apiKey);
      } else {
        localStorage.removeItem('apiKey');
      }
    },

    async switchDiscovery() {
      if (this.switchingDiscovery) return;

      this.switchingDiscovery = true;

      try {
        let config = {
          discovery_type: this.selectedDiscoveryType
        };

        // Add type-specific config
        if (this.selectedDiscoveryType === 'frp') {
          if (!this.frpConfig.server_addr) {
            alert('请输入FRP服务器地址');
            this.switchingDiscovery = false;
            return;
          }
          config = {
            ...config,
            frp_server_addr: this.frpConfig.server_addr,
            frp_server_port: this.frpConfig.server_port || 7000,
            frp_token: this.frpConfig.token || null,
            frp_remote_port: this.frpConfig.remote_port || null,
            seed_peers: this.frpConfig.seed_peers || null,
            enable_p2p: this.frpConfig.enable_p2p
          };
        } else if (this.selectedDiscoveryType === 'udp') {
          config = {
            ...config,
            listen_port: this.udpConfig.listen_port || 5678,
            broadcast_port: this.udpConfig.broadcast_port || 5678
          };
        } else if (this.selectedDiscoveryType === 'tailscale') {
          config = {
            ...config,
            tailscale_api_key: this.tailscaleConfig.api_key || null,
            tailnet_name: this.tailscaleConfig.tailnet_name || null
          };
        } else if (this.selectedDiscoveryType === 'manual') {
          config = {
            ...config,
            config_path: this.manualConfig.config_path || null
          };
        }

        const response = await fetch(`${this.endpoint}/discovery/switch`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(config)
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.detail || '切换发现模块失败');
        }

        // Update discovery status
        await this.fetchDiscoveryStatus();

        // Refresh topology
        await this.updateTopology();

        alert(`成功切换到 ${this.selectedDiscoveryType.toUpperCase()} 发现模块`);

      } catch (error) {
        console.error('切换发现模块失败:', error);
        alert(`切换失败: ${error.message}`);
      } finally {
        this.switchingDiscovery = false;
      }
    },

    initTopology() {
      // Initial fetch
      this.updateTopology();

      // Set up periodic updates
      this.topologyInterval = setInterval(() => this.updateTopology(), 5000);

      // Cleanup on page unload
      window.addEventListener('beforeunload', () => {
        if (this.topologyInterval) {
          clearInterval(this.topologyInterval);
        }
      });
    },

    async updateTopology() {
      const topologyData = await this.fetchTopology();
      if (!topologyData) return;

      const vizElement = this.$refs.topologyViz;
      vizElement.innerHTML = ''; // Clear existing visualization

      // Helper function to truncate node ID
      const truncateNodeId = (id) => id.substring(0, 8);

      // Create nodes from object
      Object.entries(topologyData.nodes).forEach(([nodeId, node]) => {
        const nodeElement = document.createElement('div');
        nodeElement.className = 'topology-node';

        // Get peer connections for this node
        const peerConnections = topologyData.peer_graph[nodeId] || [];
        const peerConnectionsHtml = peerConnections.map(peer => `
          <div class="peer-connection">
            <i class="fas fa-arrow-right"></i>
            <span>To ${truncateNodeId(peer.to_id)}: ${peer.description}</span>
          </div>
        `).join('');

        // 获取节点性能统计
        const nodeStats = topologyData.node_stats && topologyData.node_stats[nodeId];
        const statsHtml = nodeStats ? `
          <div class="node-stats">
            <div class="stat-item">
              <i class="fas fa-tasks"></i>
              <span>请求: ${nodeStats.total_requests}</span>
            </div>
            <div class="stat-item">
              <i class="fas fa-clock"></i>
              <span>平均: ${nodeStats.avg_time_per_request_ms.toFixed(1)}ms</span>
            </div>
            <div class="stat-item">
              <i class="fas fa-bolt"></i>
              <span>总计: ${nodeStats.total_time_ms.toFixed(0)}ms</span>
            </div>
          </div>
        ` : '';

        // 获取节点分片信息（优先使用多模型分片信息）
        const nodeShardsMulti = topologyData.node_shards_multi && topologyData.node_shards_multi[nodeId];
        const nodeShards = topologyData.node_shards && topologyData.node_shards[nodeId];

        let shardHtml = '';
        if (nodeShardsMulti && nodeShardsMulti.length > 0) {
          // 显示多个分片
          shardHtml = nodeShardsMulti.map(shard => `
            <div class="node-shard">
              <div class="shard-info">
                <i class="fas fa-layer-group"></i>
                <span class="shard-model">${shard.model_id}</span>
                <span class="shard-layers">层 ${shard.start_layer}-${shard.end_layer}/${shard.n_layers}</span>
              </div>
            </div>
          `).join('');
        } else if (nodeShards) {
          // 向后兼容：显示单个分片
          shardHtml = `
            <div class="node-shard">
              <div class="shard-info">
                <i class="fas fa-layer-group"></i>
                <span class="shard-model">${nodeShards.model_id}</span>
                <span class="shard-layers">层 ${nodeShards.start_layer}-${nodeShards.end_layer}/${nodeShards.n_layers}</span>
              </div>
            </div>
          `;
        }

        // 构建内存信息显示
        let memoryHtml = '';
        console.log('Node memory_detail:', node.memory_detail); // 调试信息
        if (node.memory_detail) {
          const total = (node.memory_detail.total / 1024).toFixed(1);
          const free = (node.memory_detail.free / 1024).toFixed(1);
          const used = (node.memory_detail.used / 1024).toFixed(1);
          const usagePercent = ((node.memory_detail.used / node.memory_detail.total) * 100).toFixed(1);
          memoryHtml = `
            <div class="memory-bar-container">
              <div class="memory-bar">
                <div class="memory-bar-used" style="width: ${usagePercent}%"></div>
              </div>
              <div class="memory-info">
                <span>${total}GB 总内存</span>
                <span>${free}GB 可用</span>
                <span>${used}GB 已用 (${usagePercent}%)</span>
              </div>
            </div>
          `;
        } else {
          // 向后兼容：只显示总内存
          memoryHtml = `<span>${(node.memory / 1024).toFixed(1)}GB RAM</span>`;
        }

        nodeElement.innerHTML = `
          <div class="node-info">
            <span class="status ${nodeId === topologyData.active_node_id ? 'active' : 'inactive'}"></span>
            <span>${node.model} [${truncateNodeId(nodeId)}]</span>
          </div>
          <div class="node-details">
            <span>${node.chip}</span>
            ${memoryHtml}
            <span>${node.flops.fp32.toFixed(1)} TF</span>
          </div>
          ${shardHtml}
          ${statsHtml}
          <div class="peer-connections">
            ${peerConnectionsHtml}
          </div>
        `;
        vizElement.appendChild(nodeElement);
      });
    },

    // Add these helper methods
    countDownloadedModels(models) {
      return Object.values(models).filter(model => model.downloaded).length;
    },

    getGroupCounts(groupModels) {
      const total = Object.keys(groupModels).length;
      const downloaded = this.countDownloadedModels(groupModels);
      return `[${downloaded}/${total}]`;
    },

    // Update the existing groupModelsByPrefix method to include counts
    groupModelsByPrefix(models) {
      const groups = {};
      // 显示已下载或已加载到内存的模型
      const filteredModels = this.showDownloadedOnly ?
        Object.fromEntries(Object.entries(models).filter(([, model]) => model.downloaded || model.loaded_in_memory)) :
        models;

      Object.entries(filteredModels).forEach(([key, model]) => {
        const parts = key.split('-');
        const mainPrefix = parts[0].toUpperCase();
        
        let subPrefix;
        if (parts.length === 2) {
          subPrefix = parts[1].toUpperCase();
        } else if (parts.length > 2) {
          subPrefix = parts[1].toUpperCase();
        } else {
          subPrefix = 'OTHER';
        }
        
        if (!groups[mainPrefix]) {
          groups[mainPrefix] = {};
        }
        if (!groups[mainPrefix][subPrefix]) {
          groups[mainPrefix][subPrefix] = {};
        }
        groups[mainPrefix][subPrefix][key] = model;
      });
      return groups;
    },

    toggleGroup(prefix, subPrefix = null) {
      const key = subPrefix ? `${prefix}-${subPrefix}` : prefix;
      this.expandedGroups[key] = !this.expandedGroups[key];
    },

    isGroupExpanded(prefix, subPrefix = null) {
      const key = subPrefix ? `${prefix}-${subPrefix}` : prefix;
      return this.expandedGroups[key] || false;
    },
  }));
});

const { markedHighlight } = globalThis.markedHighlight;
marked.use(markedHighlight({
  langPrefix: "hljs language-",
  highlight(code, lang, _info) {
    const language = hljs.getLanguage(lang) ? lang : "plaintext";
    return hljs.highlight(code, { language }).value;
  },
}));

// **** eventsource-parser ****
class EventSourceParserStream extends TransformStream {
  constructor() {
    let parser;

    super({
      start(controller) {
        parser = createParser((event) => {
          if (event.type === "event") {
            controller.enqueue(event);
          }
        });
      },

      transform(chunk) {
        parser.feed(chunk);
      },
    });
  }
}

function createParser(onParse) {
  let isFirstChunk;
  let buffer;
  let startingPosition;
  let startingFieldLength;
  let eventId;
  let eventName;
  let data;
  reset();
  return {
    feed,
    reset,
  };
  function reset() {
    isFirstChunk = true;
    buffer = "";
    startingPosition = 0;
    startingFieldLength = -1;
    eventId = void 0;
    eventName = void 0;
    data = "";
  }
  function feed(chunk) {
    buffer = buffer ? buffer + chunk : chunk;
    if (isFirstChunk && hasBom(buffer)) {
      buffer = buffer.slice(BOM.length);
    }
    isFirstChunk = false;
    const length = buffer.length;
    let position = 0;
    let discardTrailingNewline = false;
    while (position < length) {
      if (discardTrailingNewline) {
        if (buffer[position] === "\n") {
          ++position;
        }
        discardTrailingNewline = false;
      }
      let lineLength = -1;
      let fieldLength = startingFieldLength;
      let character;
      for (
        let index = startingPosition;
        lineLength < 0 && index < length;
        ++index
      ) {
        character = buffer[index];
        if (character === ":" && fieldLength < 0) {
          fieldLength = index - position;
        } else if (character === "\r") {
          discardTrailingNewline = true;
          lineLength = index - position;
        } else if (character === "\n") {
          lineLength = index - position;
        }
      }
      if (lineLength < 0) {
        startingPosition = length - position;
        startingFieldLength = fieldLength;
        break;
      } else {
        startingPosition = 0;
        startingFieldLength = -1;
      }
      parseEventStreamLine(buffer, position, fieldLength, lineLength);
      position += lineLength + 1;
    }
    if (position === length) {
      buffer = "";
    } else if (position > 0) {
      buffer = buffer.slice(position);
    }
  }
  function parseEventStreamLine(lineBuffer, index, fieldLength, lineLength) {
    if (lineLength === 0) {
      if (data.length > 0) {
        onParse({
          type: "event",
          id: eventId,
          event: eventName || void 0,
          data: data.slice(0, -1),
          // remove trailing newline
        });

        data = "";
        eventId = void 0;
      }
      eventName = void 0;
      return;
    }
    const noValue = fieldLength < 0;
    const field = lineBuffer.slice(
      index,
      index + (noValue ? lineLength : fieldLength),
    );
    let step = 0;
    if (noValue) {
      step = lineLength;
    } else if (lineBuffer[index + fieldLength + 1] === " ") {
      step = fieldLength + 2;
    } else {
      step = fieldLength + 1;
    }
    const position = index + step;
    const valueLength = lineLength - step;
    const value = lineBuffer.slice(position, position + valueLength).toString();
    if (field === "data") {
      data += value ? "".concat(value, "\n") : "\n";
    } else if (field === "event") {
      eventName = value;
    } else if (field === "id" && !value.includes("\0")) {
      eventId = value;
    } else if (field === "retry") {
      const retry = parseInt(value, 10);
      if (!Number.isNaN(retry)) {
        onParse({
          type: "reconnect-interval",
          value: retry,
        });
      }
    }
  }
}

const BOM = [239, 187, 191];
function hasBom(buffer) {
  return BOM.every((charCode, index) => buffer.charCodeAt(index) === charCode);
}
