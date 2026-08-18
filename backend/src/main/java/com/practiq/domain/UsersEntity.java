package com.practiq.domain;
import com.baomidou.mybatisplus.annotation.*;
@TableName("users") public class UsersEntity { @TableId(value="id",type=IdType.AUTO) public Long id; }
