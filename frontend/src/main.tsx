import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { ConfigProvider, App as AntdApp, message } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import NProgress from 'nprogress';
import 'dayjs/locale/zh-cn';
import dayjs from 'dayjs';
import App from './App';
import { createQueryClient } from './api/queryClient';
import './styles/index.css';
import './styles/nprogress.css';
import { watchCrossTabSession } from './stores/session';

// 设置dayjs语言
 dayjs.locale('zh-cn');

// 创建QueryClient实例
// 重试策略（只重试网络错误 / 5xx）与写操作失败的兜底提示见 api/queryClient.ts
const queryClient = createQueryClient({
  // 同一条提示用同一个 key：连续失败时更新同一条，不叠一串
  onUnhandledMutationError: (text) => message.error({ content: text, key: `mutation-error:${text}` }),
});

// NProgress配置
NProgress.configure({
  showSpinner: false,
  easing: 'ease',
  speed: 500,
  minimum: 0.1,
  trickleSpeed: 200,
});

// 另一个标签页换了账号时整页重载，避免本页沿用旧账号的菜单与缓存（见 watchCrossTabSession）
watchCrossTabSession();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        // ─── Linear / Vercel 配色 ────────────────────────────
        token: {
          colorPrimary: '#4F46E5',         // Indigo 600
          colorInfo: '#4F46E5',
          colorSuccess: '#10B981',         // Emerald 500
          colorWarning: '#F59E0B',         // Amber 500
          colorError: '#DC2626',           // Red 600
          colorLink: '#4F46E5',
          borderRadius: 8,
          colorBgContainer: '#ffffff',
          colorBgLayout: '#F8FAFC',        // Slate 50 — 主区背景
          colorText: '#0F172A',            // Slate 900
          colorTextSecondary: '#64748B',   // Slate 500
          colorTextTertiary: '#94A3B8',    // Slate 400
          colorBorder: '#E2E8F0',          // Slate 200
          colorBorderSecondary: '#F1F5F9', // Slate 100
          fontSize: 14,
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "微软雅黑", "Segoe UI", sans-serif',
        },
        components: {
          Layout: {
            headerBg: '#ffffff',
            siderBg: '#0F172A',            // 深板岩侧栏
            bodyBg: '#F8FAFC',
            triggerBg: '#1E293B',
          },
          Menu: {
            // 深色侧栏菜单
            darkItemBg: '#0F172A',
            darkSubMenuItemBg: '#0B1220',
            darkItemSelectedBg: '#4F46E5',  // 选中态 Indigo
            darkItemColor: '#CBD5E1',       // Slate 300
            darkItemHoverBg: '#1E293B',     // Slate 800
            darkItemHoverColor: '#FFFFFF',
            darkItemSelectedColor: '#FFFFFF',
            darkGroupTitleColor: '#64748B',
            // 浅色 Tabbar 用菜单（如有）
            itemBg: 'transparent',
            itemSelectedBg: '#EEF2FF',     // Indigo 50
            itemSelectedColor: '#4F46E5',
          },
          Card: {
            headerBg: '#ffffff',
            borderRadiusLG: 12,
          },
          Table: {
            headerBg: '#F8FAFC',
            headerColor: '#475569',
            rowHoverBg: '#F8FAFC',
            borderColor: '#E2E8F0',
          },
          Button: {
            borderRadius: 8,
            controlHeight: 36,
          },
          Input: {
            borderRadius: 8,
            controlHeight: 36,
          },
          Tabs: {
            inkBarColor: '#4F46E5',
            itemSelectedColor: '#4F46E5',
            itemHoverColor: '#4F46E5',
          },
        },
      }}
    >
      <AntdApp>
      <QueryClientProvider client={queryClient}>
        {/* 生产环境部署在 /admin/ 子路径，basename 与 vite.config base 保持一致 */}
        <BrowserRouter basename={import.meta.env.BASE_URL === '/admin/' ? '/admin' : '/'}>
          <App />
        </BrowserRouter>
      </QueryClientProvider>
      </AntdApp>
    </ConfigProvider>
  </React.StrictMode>,
);
