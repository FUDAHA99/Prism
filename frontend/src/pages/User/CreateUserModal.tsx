import React from 'react'
import { Alert, App, Form, Input, Modal, Select, Switch, Typography } from 'antd'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getSiteSettings } from '../../api/siteSetting'
import { assignRoles, createUser } from '../../api/user'
import { actionErrorMessage, errorMessage } from '../../api/errors'
import type { Role, User } from '../../types'
import { PASSWORD_HINT, passwordRule } from '../../utils/password'
import { nicknameProblem } from '../../utils/profile'
import {
  ROLE_IDS_MAX,
  assignableRoles,
  buildCreateUserPayload,
  createUserErrorField,
  defaultRoleIds,
  emailProblem,
  registrationNotice,
  registrationStateFrom,
  roleSelectionNotice,
  usernameProblem,
  type CreateUserFormValues,
} from '../../utils/create-user'

interface CreateUserModalProps {
  open: boolean
  /** GET /roles 的结果；加载失败时为 undefined（角色可以建好后在「编辑」里补） */
  roles: Role[] | undefined
  rolesFailed: boolean
  onClose: () => void
}

/** 把「返回提示或 undefined」的预检函数包成 antd 的 rules 项 */
function problemRule(check: (value: string | undefined) => string | undefined) {
  return {
    validator: (_: unknown, value: string | undefined) => {
      const problem = check(value)
      return problem ? Promise.reject(new Error(problem)) : Promise.resolve()
    },
  }
}

interface CreateResult {
  user: User
  /** 账号已建好、分配角色那一步失败时的错误 */
  roleError?: unknown
}

/** 角色多选 + 选择后的提示（放在 Form 里面，用表单上下文取当前值） */
function RoleField({ options, rolesFailed }: { options: Role[]; rolesFailed: boolean }) {
  const roleIds = Form.useWatch<string[] | undefined>('roleIds')
  const notice = roleSelectionNotice(roleIds, options)
  return (
    <Form.Item
      name="roleIds"
      label="角色"
      extra={
        notice ? (
          <Typography.Text type={notice.type === 'warning' ? 'warning' : 'secondary'}>{notice.text}</Typography.Text>
        ) : undefined
      }
    >
      <Select
        mode="multiple"
        placeholder={rolesFailed ? '角色列表加载失败，可建好后在「编辑」里分配' : '选择角色'}
        status={rolesFailed ? 'warning' : undefined}
        options={options.map((role) => ({ label: role.name, value: role.id }))}
        optionFilterProp="label"
        maxCount={ROLE_IDS_MAX}
        allowClear
      />
    </Form.Item>
  )
}

/**
 * 后台「用户管理 → 新建用户」（仅 admin：整个用户管理页只对 admin 开放）。
 *
 * 公开注册关闭时，后台账号只能从这里开设（顶部提示按系统配置里注册开关的实际值说，见 registrationNotice）。分两步：POST /users 建账号，再 POST /users/:id/assign-roles 分配角色
 * （后端新建接口不收角色）。第二步失败时账号已经建好：关闭弹窗、刷新列表，并说明要在「编辑」里补角色 ——
 * 不能停在弹窗里让人重试，再提交一次只会得到「该用户名已被使用」。
 * 后端拒绝新建时，认得出字段的提示（如 409「该邮箱已被注册」）显示在对应输入框下，其余整体提示。
 */
export default function CreateUserModal({ open, roles, rolesFailed, onClose }: CreateUserModalProps) {
  const { message, modal } = App.useApp()
  const queryClient = useQueryClient()
  const [form] = Form.useForm<CreateUserFormValues>()
  const options = assignableRoles(roles)
  // 与「系统配置」页同一个查询（admin 才进得了用户管理，也就读得了系统配置）；打开弹窗时才读。
  // 读取失败只是提示改用中性说法，不影响新建
  const { data: settings } = useQuery({ queryKey: ['site-settings'], queryFn: getSiteSettings, enabled: open })
  const notice = registrationNotice(registrationStateFrom(settings))

  const mutation = useMutation({
    mutationFn: async (values: CreateUserFormValues): Promise<CreateResult> => {
      const user = await createUser(buildCreateUserPayload(values))
      const roleIds = values.roleIds ?? []
      if (roleIds.length === 0) return { user }
      try {
        await assignRoles(user.id, roleIds)
        return { user }
      } catch (roleError) {
        return { user, roleError }
      }
    },
    onSuccess: ({ user, roleError }) => {
      queryClient.invalidateQueries({ queryKey: ['users'] })
      onClose()
      if (roleError) {
        // 多半是选中的角色刚被删掉（404「部分角色不存在」）：角色列表一并刷新，编辑弹窗里就不会再出现它
        queryClient.invalidateQueries({ queryKey: ['roles'] })
        modal.warning({
          title: '用户已创建，但角色没有分配成功',
          content: `用户「${user.username}」已创建，分配角色失败：${errorMessage(roleError, '请稍后重试')}。请在列表里点「编辑」补上角色。`,
        })
      } else {
        message.success(`用户「${user.username}」已创建`)
      }
    },
    onError: (err: Error) => {
      const field = createUserErrorField(err.message)
      if (field) {
        form.setFields([{ name: field, errors: [err.message] }])
      } else {
        message.error(actionErrorMessage('创建失败', err))
      }
    },
  })

  const handleOk = () => {
    form
      .validateFields()
      .then((values) => mutation.mutate(values))
      // 前端预检没过：提示已经显示在各输入框下，不发请求
      .catch(() => undefined)
  }

  const pending = mutation.isPending

  return (
    <Modal
      title="新建用户"
      open={open}
      onOk={handleOk}
      onCancel={onClose}
      okText="创建"
      cancelText="取消"
      confirmLoading={pending}
      // 请求进行中不能关：结果（尤其是「已创建但角色没分配上」）要能显示出来
      cancelButtonProps={{ disabled: pending }}
      closable={!pending}
      maskClosable={!pending}
      keyboard={!pending}
      width={520}
      destroyOnHidden
    >
      <Alert type={notice.type} showIcon style={{ margin: '16px 0' }} message={notice.text} />
      <Form
        form={form}
        layout="vertical"
        // 每次打开都是新挂载的空表单（父组件每次打开换 key）：默认启用、默认 editor
        initialValues={{ isActive: true, roleIds: defaultRoleIds(options) }}
        autoComplete="off"
      >
        <Form.Item
          name="username"
          label="用户名"
          extra="字母、数字、下划线和连字符，3–50 个字符，保存为小写"
          rules={[{ required: true, whitespace: true, message: '请输入用户名' }, problemRule(usernameProblem)]}
        >
          <Input placeholder="如 editor_zhang" autoComplete="off" />
        </Form.Item>

        <Form.Item
          name="email"
          label="邮箱"
          extra="登录用的邮箱"
          rules={[{ required: true, whitespace: true, message: '请输入邮箱' }, problemRule(emailProblem)]}
        >
          <Input placeholder="name@example.com" autoComplete="off" />
        </Form.Item>

        <Form.Item name="nickname" label="昵称" rules={[problemRule(nicknameProblem)]}>
          <Input placeholder="可选，2–100 个字符；不能与其他用户的用户名或昵称相同" />
        </Form.Item>

        <Form.Item
          name="password"
          label="初始密码"
          rules={[{ required: true, message: '请输入初始密码' }, passwordRule('密码')]}
        >
          {/* new-password：不让浏览器把管理员自己保存的登录口令自动填进来 */}
          <Input.Password placeholder={PASSWORD_HINT} autoComplete="new-password" />
        </Form.Item>

        <Form.Item
          name="confirmPassword"
          label="确认密码"
          dependencies={['password']}
          rules={[
            { required: true, message: '请再次输入初始密码' },
            ({ getFieldValue }) => ({
              validator(_, value) {
                if (!value || getFieldValue('password') === value) return Promise.resolve()
                return Promise.reject(new Error('两次输入的密码不一致'))
              },
            }),
          ]}
        >
          <Input.Password placeholder="再输入一次" autoComplete="new-password" />
        </Form.Item>

        <RoleField options={options} rolesFailed={rolesFailed} />

        <Form.Item name="isActive" label="账号状态" valuePropName="checked">
          <Switch checkedChildren="正常" unCheckedChildren="禁用" />
        </Form.Item>
      </Form>
    </Modal>
  )
}
