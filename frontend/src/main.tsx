import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConfigProvider, App as AntdApp } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { Toaster } from 'react-hot-toast';
import NProgress from 'nprogress';
import 'dayjs/locale/zh-cn';
import dayjs from 'dayjs';
import App from './App';
import './styles/index.css';
import './styles/nprogress.css';

// 设置dayjs语言
 dayjs.locale('zh-cn');

// 创建QueryClient实例
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 3,
      retryDelay: attemptIndex => Math.min(1000 * 2 ** attemptIndex, 30000),
      staleTime: 5 * 60 * 1000, // 5分钟
      gcTime: 10 * 60 * 1000, // 10分钟
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: 1,
      retryDelay: 1000,
    },
  },
});

// NProgress配置
NProgress.configure({
  showSpinner: false,
  easing: 'ease',
  speed: 500,
  minimum: 0.1,
  trickleSpeed: 200,
});

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
        <BrowserRouter>
          <App />
        </BrowserRouter>
        <Toaster
          position="top-right"
          toastOptions={{
            duration: 3000,
            style: {
              background: '#363636',
              color: '#fff',
            },
            success: {
              duration: 3000,
              iconTheme: {
                primary: '#4caf50',
                secondary: '#fff',
              },
            },
            error: {
              duration: 4000,
              iconTheme: {
                primary: '#f44336',
                secondary: '#fff',
              },
            },
          }}
        />
      </QueryClientProvider>
      </AntdApp>
    </ConfigProvider>
  </React.StrictMode>,
);
